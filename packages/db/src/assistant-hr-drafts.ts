/**
 * 員工跟小香講到一半的 HR 申請草稿。資料表的理由見 schema/assistant.ts 的 assistantHrRequestDrafts。
 *
 * 這個模組守三條不變條件：
 *
 * 1. **這裡不建立任何 HR 申請。** 草稿只收集欄位、用 HR 既有的函式試算；真正送出是另一步，
 *    而且呼叫的是 HR 頁面用的同一支建立函式。請假怎麼算時數、能不能請，規則只有 hr-leave 那一份。
 * 2. **一段對話同時只有一張進行中的草稿。** 已經有一張時不會自動換掉：模型要回頭提醒員工
 *    「還有一張沒填完，要繼續還是取消」，由員工決定。靜靜換掉的話，員工以為兩張都還在。
 * 3. **存不進去的欄位不會留下一半。** 任何一個欄位不合法就整次不存，草稿維持上一次的樣子，
 *    模型拿到的錯誤訊息就是要問員工的問題。
 */
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { calculateHrLeaveDuration, listHrSelfLeaveTypeOptions, type HrLeaveDurationInput } from "./hr-leave.js";
import { HrError } from "./hr-people.js";
import { assistantHrRequestDrafts, type ASSISTANT_HR_REQUEST_DRAFT_KINDS } from "./schema/assistant.js";
import { formatTaipeiDate, taipeiMinuteFromUtcWallClock, taipeiWallClockToUtc } from "./taipei-time.js";

export type HrRequestDraftKind = (typeof ASSISTANT_HR_REQUEST_DRAFT_KINDS)[number];

/** 目前做得到的種類。加班與補打卡的表已經留了位置，還沒有對應的收集與送出邏輯。 */
const SUPPORTED_KINDS: readonly HrRequestDraftKind[] = ["leave"];
const KIND_LABELS: Record<HrRequestDraftKind, string> = { leave: "請假", overtime: "加班", clock_correction: "補打卡" };
/** 草稿多久沒動就作廢。隔天再回來講「上午」，多半已經不是在講同一件事。 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"] as const;

export interface HrRequestDraftScope {
  assistantKey: string;
  surface: "line" | "sandbox";
  /** LINE 才有；Sandbox 傳 null。 */
  channelKey: string | null;
  conversationKey: string;
  /** 申請人。 */
  userId: string;
  /** Sandbox 模擬本人時的操作者。 */
  actorUserId?: string | null;
}

export interface HrLeaveDraftFields {
  leaveTypeId?: string;
  /** 台北時間 `YYYY-MM-DD HH:mm`。 */
  startsAt?: string;
  endsAt?: string;
  reason?: string;
}

export interface HrRequestDraftInput extends HrLeaveDraftFields {
  kind: string;
}

type DraftRow = typeof assistantHrRequestDrafts.$inferSelect;

function parseFields(row: DraftRow): HrLeaveDraftFields {
  try {
    const value = JSON.parse(row.payloadJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as HrLeaveDraftFields : {};
  } catch {
    return {};
  }
}

function taipeiMinute(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) throw new HrError(400, `${label}必須是台北時間 YYYY-MM-DD HH:mm。`);
  try {
    return taipeiWallClockToUtc(`${value}:00`);
  } catch {
    throw new HrError(400, `${label}不是有效的日期時間。`);
  }
}

function withWeekday(taipeiMinuteText: string) {
  const date = taipeiMinuteText.slice(0, 10);
  return `${date}（${WEEKDAY_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()]}）${taipeiMinuteText.slice(11)}`;
}

function hours(minutes: number) {
  return `${minutes / 60} 小時`;
}

/** 草稿屬於哪一段對話。assistant 與 channel 也一起比：對話鍵值只在自己的 channel 裡保證唯一。 */
export type HrRequestDraftConversation = Pick<HrRequestDraftScope, "assistantKey" | "surface" | "channelKey" | "conversationKey">;

function inConversation(scope: HrRequestDraftConversation) {
  return and(
    eq(assistantHrRequestDrafts.assistantKey, scope.assistantKey),
    eq(assistantHrRequestDrafts.surface, scope.surface),
    scope.channelKey === null ? isNull(assistantHrRequestDrafts.channelKey) : eq(assistantHrRequestDrafts.channelKey, scope.channelKey),
    eq(assistantHrRequestDrafts.conversationKey, scope.conversationKey),
    eq(assistantHrRequestDrafts.status, "open"),
  );
}

async function activeDraft(db: Database, scope: HrRequestDraftConversation, now: number) {
  const [row] = await db.select().from(assistantHrRequestDrafts)
    .where(and(inConversation(scope), gt(assistantHrRequestDrafts.expiresAt, new Date(now).toISOString()))).limit(1);
  return row ?? null;
}

/** 過期的草稿還佔著「進行中」的唯一索引；開新的之前先把它們收掉。 */
async function retireExpired(db: Database, scope: HrRequestDraftConversation, now: number) {
  const nowIso = new Date(now).toISOString();
  await db.update(assistantHrRequestDrafts).set({ status: "cancelled", updatedAt: nowIso })
    .where(and(inConversation(scope), lte(assistantHrRequestDrafts.expiresAt, nowIso)));
}

/** 對話裡的草稿只能是這個人的；LINE 私訊與 Sandbox 的模擬對象理論上不會換人，換了就不該讓他看到別人的。 */
function assertOwner(row: DraftRow, scope: HrRequestDraftScope) {
  if (row.userId !== scope.userId) throw new HrError(409, "這段對話有另一位員工的申請草稿，請先清除對話。");
}

/**
 * 草稿裡的時間換成 HR 函式要的輸入，唯一的一處。
 *
 * 草稿存的是員工講的台北時間（卡片也是照這個印），HR 的表與函式用的是 UTC wall-clock。
 * 試算與之後的送出都必須從這裡拿輸入：各自轉換的話，漏掉一次就是差八小時的假單。
 */
function leaveInterval(userId: string, fields: HrLeaveDraftFields): HrLeaveDurationInput | null {
  if (!fields.startsAt || !fields.endsAt) return null;
  return { employeeUserId: userId, startsAt: taipeiMinute(fields.startsAt, "開始時間"), endsAt: taipeiMinute(fields.endsAt, "結束時間") };
}

async function leaveView(db: Database, row: DraftRow, now: number) {
  const fields = parseFields(row);
  const leaveTypes = await listHrSelfLeaveTypeOptions(db, row.userId, formatTaipeiDate(now));
  const leaveType = leaveTypes.find((option) => option.id === fields.leaveTypeId);
  // 假別可能在草稿建立後被停用；當成還沒選，讓模型重新問，而不是到送出才失敗。
  const leaveTypeId = leaveType ? fields.leaveTypeId : undefined;
  let durationMinutes: number | null = null;
  let problem: string | null = null;
  const interval = leaveInterval(row.userId, fields);
  if (interval) {
    try {
      durationMinutes = (await calculateHrLeaveDuration(db, interval)).durationMinutes;
    } catch (error) {
      // 班表在草稿存好之後改了，原本合法的時段可能變得不能請；講出原因讓員工改時間。
      if (!(error instanceof HrError)) throw error;
      problem = error.message.trim();
    }
  }
  const missing = [
    ...(leaveTypeId ? [] : ["leaveTypeId"]),
    ...(fields.startsAt ? [] : ["startsAt"]),
    ...(fields.endsAt ? [] : ["endsAt"]),
    ...(fields.reason?.trim() ? [] : ["reason"]),
  ];
  const ready = !missing.length && durationMinutes !== null;
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind],
    status: ready ? "ready" as const : "collecting" as const,
    fields: {
      leaveTypeId: leaveTypeId ?? null,
      leaveTypeName: leaveType?.name ?? null,
      startsAt: fields.startsAt ?? null,
      endsAt: fields.endsAt ?? null,
      durationMinutes,
      reason: fields.reason?.trim() || null,
    },
    missing,
    problem,
    // 只在還沒選假別時給選項：選好了就不用每一輪都把所有假別與特休餘額再送給模型一次。
    leaveTypeOptions: leaveTypeId ? [] : leaveTypes.map((option) => ({
      id: option.id,
      name: option.name,
      ...(option.leaveKind === "annual" ? { remainingMinutes: option.credits.reduce((total, credit) => total + credit.balanceHalfHours * 30, 0) } : {}),
    })),
    card: ready ? [
      "請假申請（尚未送出）",
      `假別：${leaveType!.name}`,
      `開始：${withWeekday(fields.startsAt!)}`,
      `結束：${withWeekday(fields.endsAt!)}`,
      `時數：${hours(durationMinutes!)}`,
      `原因：${fields.reason!.trim()}`,
    ].join("\n") : null,
    expiresAt: taipeiMinuteFromUtcWallClock(row.expiresAt),
    timeZone: "Asia/Taipei",
  };
}

export type HrRequestDraftView = Awaited<ReturnType<typeof leaveView>>;

/** 讀這段對話進行中的草稿；沒有就是 null。 */
export async function getHrRequestDraft(db: Database, scope: HrRequestDraftScope, now = Date.now()): Promise<HrRequestDraftView | null> {
  const row = await activeDraft(db, scope, now);
  if (!row) return null;
  assertOwner(row, scope);
  return leaveView(db, row, now);
}

/**
 * 給「每一輪開始前提醒模型」用：只回有沒有草稿、是哪一種，不帶任何欄位。
 * 這句提醒會進 system prompt，而 LINE 的 HR 內容原則上不進 transcript，所以不能把草稿內容放進來。
 */
export async function hrRequestDraftHint(db: Database, scope: HrRequestDraftScope, now = Date.now()) {
  const row = await activeDraft(db, scope, now);
  // 草稿不是這個人的就不提：提了等於告訴他「這段對話有別人的申請」，而他接下來每個草稿工具都會被擋。
  return row && row.userId === scope.userId ? { kind: row.kind, kindLabel: KIND_LABELS[row.kind] } : null;
}

/** 把這一輪新知道的欄位併進草稿；沒有草稿就開一張。回傳的 missing 就是接下來要問員工的事。 */
export async function saveHrRequestDraft(db: Database, scope: HrRequestDraftScope, input: HrRequestDraftInput, now = Date.now()): Promise<HrRequestDraftView> {
  if (!(SUPPORTED_KINDS as readonly string[]).includes(input.kind)) {
    throw new HrError(400, `目前只能透過小香申請${SUPPORTED_KINDS.map((kind) => KIND_LABELS[kind]).join("、")}。`);
  }
  const kind = input.kind as HrRequestDraftKind;
  await retireExpired(db, scope, now);
  const current = await activeDraft(db, scope, now);
  if (current) {
    assertOwner(current, scope);
    if (current.kind !== kind) {
      throw new HrError(409, `已經有一張還沒完成的${KIND_LABELS[current.kind]}草稿。請先問員工要繼續那一張，還是取消它；取消後才能開始新的${KIND_LABELS[kind]}申請。`);
    }
  }

  const previous = current ? parseFields(current) : {};
  const next: HrLeaveDraftFields = { ...previous };
  if (input.leaveTypeId !== undefined) {
    const options = await listHrSelfLeaveTypeOptions(db, scope.userId, formatTaipeiDate(now));
    if (!options.some((option) => option.id === input.leaveTypeId)) {
      throw new HrError(400, `沒有這個假別。可以選的假別：${options.map((option) => `${option.name}（${option.id}）`).join("、") || "目前沒有啟用的假別"}。`);
    }
    next.leaveTypeId = input.leaveTypeId;
  }
  if (input.startsAt !== undefined) { taipeiMinute(input.startsAt, "開始時間"); next.startsAt = input.startsAt; }
  if (input.endsAt !== undefined) { taipeiMinute(input.endsAt, "結束時間"); next.endsAt = input.endsAt; }
  if (input.reason !== undefined) {
    const reason = input.reason.trim();
    if (reason.length > 1000) throw new HrError(400, "請假原因不可超過 1000 字。");
    next.reason = reason;
  }
  // 兩個時間都有了就立刻用 HR 的規則試算：不合法的時段（不在班表上、不是半小時的倍數、任職期間外）
  // 在這裡就擋下來並把原因回給模型，不留到員工按下確認才失敗。
  const interval = leaveInterval(scope.userId, next);
  if (interval && (input.startsAt !== undefined || input.endsAt !== undefined)) await calculateHrLeaveDuration(db, interval);

  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + DRAFT_TTL_MS).toISOString();
  const payloadJson = JSON.stringify(next);
  if (current) {
    // 用 revision 守門：同一段對話的兩輪並行時，後到的不會靜靜蓋掉先到的。
    const updated = await db.update(assistantHrRequestDrafts)
      .set({ payloadJson, expiresAt, updatedAt: nowIso, revision: sql`${assistantHrRequestDrafts.revision} + 1` })
      .where(and(eq(assistantHrRequestDrafts.id, current.id), eq(assistantHrRequestDrafts.revision, current.revision), eq(assistantHrRequestDrafts.status, "open")))
      .returning({ id: assistantHrRequestDrafts.id });
    if (!updated.length) throw new HrError(409, "草稿剛剛被更新或取消了，請重新讀取草稿再繼續。");
  } else {
    try {
      await db.insert(assistantHrRequestDrafts).values({
        id: crypto.randomUUID(), assistantKey: scope.assistantKey, channelKey: scope.channelKey, surface: scope.surface,
        conversationKey: scope.conversationKey, userId: scope.userId, actorUserId: scope.actorUserId ?? null,
        kind, payloadJson, expiresAt, createdAt: nowIso, updatedAt: nowIso,
      });
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "這段對話已經有一張進行中的草稿，請重新讀取草稿再繼續。");
      throw error;
    }
  }
  const saved = await activeDraft(db, scope, now);
  if (!saved) throw new HrError(409, "草稿剛剛被取消了，請重新開始。");
  return leaveView(db, saved, now);
}

/** 員工說不申請了。沒有草稿時回 false，讓模型照實說「本來就沒有」。 */
export async function cancelHrRequestDraft(db: Database, scope: HrRequestDraftScope, now = Date.now()): Promise<{ cancelled: boolean; kindLabel: string | null }> {
  const current = await activeDraft(db, scope, now);
  if (!current) return { cancelled: false, kindLabel: null };
  assertOwner(current, scope);
  const updated = await db.update(assistantHrRequestDrafts)
    .set({ status: "cancelled", updatedAt: new Date(now).toISOString(), revision: sql`${assistantHrRequestDrafts.revision} + 1` })
    .where(and(eq(assistantHrRequestDrafts.id, current.id), eq(assistantHrRequestDrafts.status, "open")))
    .returning({ id: assistantHrRequestDrafts.id });
  return { cancelled: updated.length > 0, kindLabel: KIND_LABELS[current.kind] };
}
