/**
 * 員工跟小香講到一半的 HR 申請草稿。資料表的理由見 schema/assistant.ts 的 assistantHrRequestDrafts。
 *
 * 這個模組守三條不變條件：
 *
 * 1. **只有 confirmHrRequestDraft 會建立 HR 申請，而且它不是給模型用的。** 模型拿到的 get／save／cancel
 *    只收集欄位、用 HR 既有的函式試算。送出是員工按下確認之後由程式呼叫，建立時用的是 HR 頁面的同一支函式：
 *    請假怎麼算時數、能不能請、送給誰審，規則只有 hr-leave 那一份。
 * 2. **一段對話同時只有一張進行中的草稿。** 已經有一張時不會自動換掉：模型要回頭提醒員工
 *    「還有一張沒填完，要繼續還是取消」，由員工決定。靜靜換掉的話，員工以為兩張都還在。
 * 3. **存不進去的欄位不會留下一半。** 任何一個欄位不合法就整次不存，草稿維持上一次的樣子，
 *    模型拿到的錯誤訊息就是要問員工的問題。
 */
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { calculateHrLeaveDuration, createHrLeaveRequest, listHrSelfLeaveTypeOptions, type HrLeaveDurationInput } from "./hr-leave.js";
import { HrError, type HrActor } from "./hr-people.js";
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

/**
 * 這段對話進行中的草稿，而且是這個人的。
 *
 * 同一段對話換了人（LINE 帳號解除綁定後綁給另一位員工）時，前一個人留下的草稿對現在這個人來說
 * 就是不存在：不讓他讀、不讓他改，也不告訴他「這裡有別人的申請」。
 */
async function ownDraft(db: Database, scope: HrRequestDraftScope, now: number) {
  const row = await activeDraft(db, scope, now);
  return row && row.userId === scope.userId ? row : null;
}

/** 把這段對話所有還開著的草稿收掉，不管是誰的。重設對話、或對話換了人要開新草稿時用。 */
export async function discardHrRequestDrafts(db: Database, scope: HrRequestDraftConversation, now = Date.now()): Promise<void> {
  await db.update(assistantHrRequestDrafts)
    .set({ status: "cancelled", updatedAt: new Date(now).toISOString(), revision: sql`${assistantHrRequestDrafts.revision} + 1` })
    .where(inConversation(scope));
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
    /** 確認按鈕帶著它：員工按的是哪一版的卡片，送出的就必須是哪一版。 */
    revision: row.revision,
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
  const row = await ownDraft(db, scope, now);
  return row ? leaveView(db, row, now) : null;
}

/**
 * 給「每一輪開始前提醒模型」用：只回有沒有草稿、是哪一種，不帶任何欄位。
 * 這句提醒會進 system prompt，而 LINE 的 HR 內容原則上不進 transcript，所以不能把草稿內容放進來。
 */
export async function hrRequestDraftHint(db: Database, scope: HrRequestDraftScope, now = Date.now()) {
  // 草稿不是這個人的就不提：提了等於告訴他「這段對話有別人的申請」。
  const row = await ownDraft(db, scope, now);
  return row ? { kind: row.kind, kindLabel: KIND_LABELS[row.kind] } : null;
}

/** 把這一輪新知道的欄位併進草稿；沒有草稿就開一張。回傳的 missing 就是接下來要問員工的事。 */
export async function saveHrRequestDraft(db: Database, scope: HrRequestDraftScope, input: HrRequestDraftInput, now = Date.now()): Promise<HrRequestDraftView> {
  if (!(SUPPORTED_KINDS as readonly string[]).includes(input.kind)) {
    throw new HrError(400, `目前只能透過小香申請${SUPPORTED_KINDS.map((kind) => KIND_LABELS[kind]).join("、")}。`);
  }
  const kind = input.kind as HrRequestDraftKind;
  await retireExpired(db, scope, now);
  const occupying = await activeDraft(db, scope, now);
  // 佔著位置的是前一個人的草稿：收掉它，現在這個人從空白開始。
  if (occupying && occupying.userId !== scope.userId) await discardHrRequestDrafts(db, scope, now);
  const current = occupying && occupying.userId === scope.userId ? occupying : null;
  if (current && current.kind !== kind) {
    throw new HrError(409, `已經有一張還沒完成的${KIND_LABELS[current.kind]}草稿。請先問員工要繼續那一張，還是取消它；取消後才能開始新的${KIND_LABELS[kind]}申請。`);
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
  const saved = await ownDraft(db, scope, now);
  if (!saved) throw new HrError(409, "草稿剛剛被取消了，請重新開始。");
  return leaveView(db, saved, now);
}

/** 員工說不申請了。沒有草稿時回 false，讓模型照實說「本來就沒有」。 */
export async function cancelHrRequestDraft(db: Database, scope: HrRequestDraftScope, now = Date.now()): Promise<{ cancelled: boolean; kindLabel: string | null }> {
  const current = await ownDraft(db, scope, now);
  if (!current) return { cancelled: false, kindLabel: null };
  const updated = await db.update(assistantHrRequestDrafts)
    .set({ status: "cancelled", updatedAt: new Date(now).toISOString(), revision: sql`${assistantHrRequestDrafts.revision} + 1` })
    .where(and(eq(assistantHrRequestDrafts.id, current.id), eq(assistantHrRequestDrafts.status, "open")))
    .returning({ id: assistantHrRequestDrafts.id });
  return { cancelled: updated.length > 0, kindLabel: KIND_LABELS[current.kind] };
}

export type HrRequestDraftConfirmation =
  /** 申請建立了。card 是送出時的內容，回覆員工用。 */
  | { outcome: "submitted"; kindLabel: string; requestId: string; card: string }
  | { outcome: "cancelled"; kindLabel: string }
  /** 找不到、不是這個人的、不是這段對話的、已取消或已過期：對按的人來說都是「這張已經不在了」。 */
  | { outcome: "gone" }
  | { outcome: "already_submitted"; kindLabel: string }
  /** 卡片發出去之後草稿又被改過：他按的那一版已經不是現在的內容。 */
  | { outcome: "changed"; kindLabel: string }
  | { outcome: "not_ready"; kindLabel: string; problem: string | null }
  /** HR 的建立函式拒絕了（時段重疊、任職無效…）；草稿退回開著的狀態，員工可以改了再送。 */
  | { outcome: "rejected"; kindLabel: string; message: string };

/**
 * 員工按下確認卡片上的按鈕。**這是唯一會建立 HR 申請的地方，呼叫端必須已經確認按的人是誰**——
 * userId 要來自執行環境驗過的身分（LINE 綁定），不能來自按鈕帶的資料或模型。
 *
 * 送出分三步，順序是為了「同一張草稿最多變成一張申請」：
 * 1. 先把草稿從 open 改成 submitted（搶到的人才往下走）。按兩下、LINE 重送 webhook，第二次都搶不到。
 * 2. 再呼叫 HR 的建立函式。
 * 3. 建立失敗就把草稿退回 open，讓員工改了再送；成功就記下申請的 id。
 *
 * 這幾步不在同一個 transaction 裡，所以每一個中斷點都要落在「不會多送」那一邊：
 * - 搶到之後、建立之前中斷：留下一張 submitted 但沒有 submittedRequestId 的草稿，申請沒有建立。
 *   寧可少送一張（員工會發現沒有待審單），也不要因為重試而多送一張。
 * - 建立成功之後、記下 id 之前中斷或失敗：申請已經存在，草稿維持 submitted。**只有建立函式自己丟出錯誤
 *   才退回 open**；記 id 失敗不算。把這兩種失敗混在一起退回的話，員工再按一次就是第二張申請。
 */
export async function confirmHrRequestDraft(
  db: Database,
  input: {
    draftId: string; revision: number; action: "submit" | "cancel";
    conversation: HrRequestDraftConversation; userId: string; actor: HrActor;
  },
  now = Date.now(),
): Promise<HrRequestDraftConfirmation> {
  const [row] = await db.select().from(assistantHrRequestDrafts).where(eq(assistantHrRequestDrafts.id, input.draftId)).limit(1);
  const nowIso = new Date(now).toISOString();
  if (!row || row.userId !== input.userId || input.actor.id !== input.userId
    || row.assistantKey !== input.conversation.assistantKey || row.surface !== input.conversation.surface
    || row.channelKey !== input.conversation.channelKey || row.conversationKey !== input.conversation.conversationKey) return { outcome: "gone" };
  const kindLabel = KIND_LABELS[row.kind];
  if (row.status === "submitted") return { outcome: "already_submitted", kindLabel };
  if (row.status !== "open" || row.expiresAt <= nowIso) return { outcome: "gone" };
  if (row.revision !== input.revision) return { outcome: "changed", kindLabel };

  const claim = (status: "submitted" | "cancelled") => db.update(assistantHrRequestDrafts)
    .set({ status, updatedAt: nowIso, revision: sql`${assistantHrRequestDrafts.revision} + 1` })
    .where(and(eq(assistantHrRequestDrafts.id, row.id), eq(assistantHrRequestDrafts.status, "open"), eq(assistantHrRequestDrafts.revision, row.revision)))
    .returning({ id: assistantHrRequestDrafts.id });

  if (input.action === "cancel") return (await claim("cancelled")).length ? { outcome: "cancelled", kindLabel } : { outcome: "changed", kindLabel };

  // 卡片發出去之後假別可能被停用、班表可能改了：送出前照現在的規則再算一次，不信卡片當時的樣子。
  const view = await leaveView(db, row, now);
  const fields = parseFields(row);
  const interval = leaveInterval(row.userId, fields);
  if (view.status !== "ready" || !view.card || !interval || !view.fields.leaveTypeId || !view.fields.reason) {
    return { outcome: "not_ready", kindLabel, problem: view.problem };
  }
  if (!(await claim("submitted")).length) {
    const [latest] = await db.select({ status: assistantHrRequestDrafts.status }).from(assistantHrRequestDrafts).where(eq(assistantHrRequestDrafts.id, row.id)).limit(1);
    return latest?.status === "submitted" ? { outcome: "already_submitted", kindLabel } : { outcome: "changed", kindLabel };
  }
  let requestId: string;
  try {
    requestId = (await createHrLeaveRequest(db, { ...interval, leaveTypeId: view.fields.leaveTypeId, reason: view.fields.reason }, input.actor)).id;
  } catch (error) {
    // 退回 open 並把期限往後延：員工要有時間改。revision 已經在搶的時候加過，舊卡片上的按鈕因此失效。
    await db.update(assistantHrRequestDrafts)
      .set({ status: "open", expiresAt: new Date(now + DRAFT_TTL_MS).toISOString(), updatedAt: nowIso })
      .where(and(eq(assistantHrRequestDrafts.id, row.id), eq(assistantHrRequestDrafts.status, "submitted"), isNull(assistantHrRequestDrafts.submittedRequestId)));
    if (error instanceof HrError) return { outcome: "rejected", kindLabel, message: error.message.trim() };
    throw error;
  }
  // 申請已經建立，從這裡開始不能再讓任何失敗把草稿退回去。id 只是方便追查，記不上不影響結果。
  await db.update(assistantHrRequestDrafts).set({ submittedRequestId: requestId }).where(eq(assistantHrRequestDrafts.id, row.id)).catch(() => undefined);
  return { outcome: "submitted", kindLabel, requestId, card: view.card };
}
