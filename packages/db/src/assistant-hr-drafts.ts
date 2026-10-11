/**
 * 員工跟小香講到一半的 HR 申請草稿。資料表的理由見 schema/assistant.ts 的 assistantHrRequestDrafts。
 *
 * 這個模組守三條不變條件：
 *
 * 1. **只有 confirmHrRequestDraft 會建立 HR 申請，而且它不是給模型用的。** 模型拿到的 get／save／cancel
 *    只收集欄位、用 HR 既有的函式試算。送出是員工按下確認之後由程式呼叫，建立時用的是 HR 頁面的同一支函式：
 *    怎麼算時數、能不能申請、送給誰審，規則只有 HR 模組那一份（hr-leave、hr-overtime、hr-requests）。
 * 2. **一段對話同時只有一張進行中的草稿。** 已經有一張時不會自動換掉：模型要回頭提醒員工
 *    「還有一張沒填完，要繼續還是取消」，由員工決定。靜靜換掉的話，員工以為兩張都還在。
 * 3. **存不進去的欄位不會留下一半。** 任何一個欄位不合法，這一次帶來的欄位就一個都不存，
 *    模型拿到的錯誤訊息就是要問員工的問題。留得下來的只有兩樣不屬於欄位的東西：草稿本身
 *    （第一次存就失敗時仍然開一張只有種類的草稿）與模型寫的備註 notes——少了它們，
 *    下一輪模型不知道員工在申請什麼、也不知道他剛剛講了什麼。
 */
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { checkHrSelfLeaveRequest, createHrLeaveRequest, listHrSelfLeaveTypeOptions, type HrLeaveDurationInput } from "./hr-leave.js";
import { checkHrSelfOvertimeRequest, createHrOvertimeRequest, type HrOvertimeInput } from "./hr-overtime.js";
import { HrError, type HrActor } from "./hr-people.js";
import { checkHrSelfClockCorrection, createAndSubmitHrClockCorrection, type HrSelfClockCorrectionInput } from "./hr-requests.js";
import { assistantHrRequestDrafts, type ASSISTANT_HR_REQUEST_DRAFT_KINDS } from "./schema/assistant.js";
import { formatTaipeiDate, taipeiMinuteFromUtcWallClock, taipeiWallClockToUtc } from "./taipei-time.js";

export type HrRequestDraftKind = (typeof ASSISTANT_HR_REQUEST_DRAFT_KINDS)[number];

const KIND_LABELS: Record<HrRequestDraftKind, string> = { leave: "請假", overtime: "加班", clock_correction: "補打卡" };
/** 草稿多久沒動就作廢。隔天再回來講「上午」，多半已經不是在講同一件事。 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"] as const;
const NO_REASON = "（未填）";

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

/** 草稿裡存的欄位。每一種申請只用到其中幾個；時間一律是員工講的台北時間 `YYYY-MM-DD HH:mm`。 */
export interface HrRequestDraftFields {
  /** 請假：假別。 */
  leaveTypeId?: string;
  /** 請假、加班：起訖。 */
  startsAt?: string;
  endsAt?: string;
  /** 補打卡：補的是上班還是下班，以及那一次打卡的時間。 */
  clockEvent?: string;
  clockAt?: string;
  reason?: string;
  /**
   * 員工講過、但還放不進上面欄位的內容，由模型用白話記下來（「下週二上午，還沒說幾點」）。
   *
   * 欄位只收完整的日期加時間，而 LINE 的 HR 回合不留 transcript：員工只講了一半的那一輪，模型沒有地方
   * 可以放，只能反問，然後下一輪連那一半都不記得。這一欄就是給那一半住的地方。它不進確認卡片、
   * 不會送出，任何一種申請都能用。
   */
  notes?: string;
}

const NOTES_MAX_LENGTH = 500;

const FIELD_KEYS = ["leaveTypeId", "startsAt", "endsAt", "clockEvent", "clockAt", "reason"] as const;
type FieldKey = (typeof FIELD_KEYS)[number];
const CLOCK_EVENT_LABELS: Record<string, string> = { clock_in: "上班打卡", clock_out: "下班打卡" };

/**
 * 每一種申請只收自己的欄位。模型把請假的假別傳進加班、或把起訖時間傳進補打卡時直接拒絕：
 * 靜靜收下的話，那個值會留在草稿裡沒有人用，而模型以為它存進去了。
 */
function assertOwnFields(input: HrRequestDraftInput, allowed: readonly FieldKey[], kindLabel: string) {
  const extra = FIELD_KEYS.filter((key) => input[key] !== undefined && !allowed.includes(key));
  if (extra.length) throw new HrError(400, `${kindLabel}申請沒有這些欄位：${extra.join("、")}。`);
}

export interface HrRequestDraftInput extends HrRequestDraftFields {
  kind: string;
}

type DraftRow = typeof assistantHrRequestDrafts.$inferSelect;

function parseFields(row: DraftRow): HrRequestDraftFields {
  try {
    const value = JSON.parse(row.payloadJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as HrRequestDraftFields : {};
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

/** 某一種申請現在的樣子：給模型看的欄位、還缺什麼，以及（齊了的話）卡片與送出的動作。 */
interface DraftDetail {
  fields: Record<string, unknown>;
  missing: string[];
  /**
   * 可以不填、但還沒填的欄位。必填與選填照 HR 頁面那張表單走（請假與加班的原因是選填）：
   * 這裡要求得比表單嚴，同一個人在兩個入口就會遇到兩套規則。模型問一次，員工說不用就不再問。
   */
  optional: string[];
  /** 欄位都有了但照現在的規則不能申請（班表改了、任職無效…）時的原因。 */
  problem: string | null;
  leaveTypeOptions?: Array<{ id: string; name: string; remainingMinutes?: number }>;
  /** 欄位齊全而且現在申請得了才有；卡片標題之後的每一行。 */
  cardLines: string[] | null;
  /**
   * 建立 HR 申請。跟卡片出自同一次計算：員工看到什麼，送出的就是什麼，不會在送出時另外再推一次輸入。
   * 只有 confirmHrRequestDraft 會呼叫它。
   */
  submit: ((actor: HrActor) => Promise<{ id: string }>) | null;
}

/** 一種申請怎麼收欄位、怎麼算。加一種申請就是加一個 handler，草稿的生命週期（搶佔、過期、換人）不用動。 */
interface DraftKindHandler {
  /** 把這一輪的輸入併進既有欄位並驗證；不合法就丟 HrError，呼叫端整次不存。 */
  merge(db: Database, userId: string, previous: HrRequestDraftFields, input: HrRequestDraftInput, now: number): Promise<HrRequestDraftFields>;
  detail(db: Database, userId: string, fields: HrRequestDraftFields, now: number): Promise<DraftDetail>;
}

function mergeInterval(next: HrRequestDraftFields, input: HrRequestDraftInput) {
  if (input.startsAt !== undefined) { taipeiMinute(input.startsAt, "開始時間"); next.startsAt = input.startsAt; }
  if (input.endsAt !== undefined) { taipeiMinute(input.endsAt, "結束時間"); next.endsAt = input.endsAt; }
  return input.startsAt !== undefined || input.endsAt !== undefined;
}

function mergeReason(next: HrRequestDraftFields, input: HrRequestDraftInput, label: string) {
  if (input.reason === undefined) return;
  const reason = input.reason.trim();
  if (reason.length > 1000) throw new HrError(400, `${label}原因不可超過 1000 字。`);
  next.reason = reason;
}

/** HR 的試算丟出的規則錯誤當成「現在不能申請的原因」；其他錯誤照樣往外丟。 */
async function problemOf<T>(check: () => Promise<T>): Promise<{ value: T | null; problem: string | null }> {
  try {
    return { value: await check(), problem: null };
  } catch (error) {
    if (!(error instanceof HrError)) throw error;
    return { value: null, problem: error.message.trim() };
  }
}

/**
 * 草稿裡的時間換成 HR 函式要的輸入，每一種申請各只有這一處。
 *
 * 草稿存的是員工講的台北時間（卡片也是照這個印），HR 的表與函式用的是 UTC wall-clock。
 * 試算與送出都必須從這裡拿輸入：各自轉換的話，漏掉一次就是差八小時的單。
 */
function leaveInterval(userId: string, fields: HrRequestDraftFields): HrLeaveDurationInput | null {
  if (!fields.startsAt || !fields.endsAt) return null;
  return { employeeUserId: userId, startsAt: taipeiMinute(fields.startsAt, "開始時間"), endsAt: taipeiMinute(fields.endsAt, "結束時間") };
}

function overtimeInput(userId: string, fields: HrRequestDraftFields): (HrOvertimeInput & { employeeUserId: string }) | null {
  if (!fields.startsAt || !fields.endsAt) return null;
  return {
    employeeUserId: userId,
    requestedStart: taipeiMinute(fields.startsAt, "開始時間"), requestedEnd: taipeiMinute(fields.endsAt, "結束時間"),
    // 本人申請的加班一律付薪（hr-overtime 的 assertSelfServiceSettlement），所以不問員工，也不讓模型選。
    settlementKind: "pay",
    reason: fields.reason ?? "",
  };
}

const leaveHandler: DraftKindHandler = {
  async merge(db, userId, previous, input, now) {
    assertOwnFields(input, ["leaveTypeId", "startsAt", "endsAt", "reason"], "請假");
    const next = { ...previous };
    if (input.leaveTypeId !== undefined) {
      const options = await listHrSelfLeaveTypeOptions(db, userId, formatTaipeiDate(now));
      if (!options.some((option) => option.id === input.leaveTypeId)) {
        throw new HrError(400, `沒有這個假別。可以選的假別：${options.map((option) => `${option.name}（${option.id}）`).join("、") || "目前沒有啟用的假別"}。`);
      }
      next.leaveTypeId = input.leaveTypeId;
    }
    const intervalChanged = mergeInterval(next, input);
    mergeReason(next, input, "請假");
    // 兩個時間都有了就立刻用 HR 的規則試算：不合法的時段（不在班表上、不是半小時的倍數、任職期間外）
    // 與找不到審核者，在這裡就擋下來並把原因回給模型，不留到員工按下確認才失敗。
    const interval = leaveInterval(userId, next);
    if (interval && intervalChanged) await checkHrSelfLeaveRequest(db, interval);
    return next;
  },
  async detail(db, userId, fields, now) {
    const leaveTypes = await listHrSelfLeaveTypeOptions(db, userId, formatTaipeiDate(now));
    // 假別可能在草稿建立後被停用；當成還沒選，讓模型重新問，而不是到送出才失敗。
    const leaveType = leaveTypes.find((option) => option.id === fields.leaveTypeId);
    const interval = leaveInterval(userId, fields);
    // 班表在草稿存好之後改了，原本合法的時段可能變得不能請；講出原因讓員工改時間。
    const { value, problem } = interval ? await problemOf(() => checkHrSelfLeaveRequest(db, interval)) : { value: null, problem: null };
    const durationMinutes = value?.durationMinutes ?? null;
    const reason = fields.reason?.trim() ?? "";
    const missing = [
      ...(leaveType ? [] : ["leaveTypeId"]),
      ...(fields.startsAt ? [] : ["startsAt"]),
      ...(fields.endsAt ? [] : ["endsAt"]),
    ];
    const ready = leaveType && interval && durationMinutes !== null
      ? { leaveType, interval, durationMinutes, reason } : null;
    return {
      fields: {
        leaveTypeId: leaveType?.id ?? null, leaveTypeName: leaveType?.name ?? null,
        startsAt: fields.startsAt ?? null, endsAt: fields.endsAt ?? null, durationMinutes, reason: reason || null,
      },
      missing, optional: reason ? [] : ["reason"], problem,
      // 只在還沒選假別時給選項：選好了就不用每一輪都把所有假別與特休餘額再送給模型一次。
      leaveTypeOptions: leaveType ? [] : leaveTypes.map((option) => ({
        id: option.id,
        name: option.name,
        ...(option.leaveKind === "annual" ? { remainingMinutes: option.credits.reduce((total, credit) => total + credit.balanceHalfHours * 30, 0) } : {}),
      })),
      cardLines: ready ? [
        `假別：${ready.leaveType.name}`,
        `開始：${withWeekday(fields.startsAt!)}`,
        `結束：${withWeekday(fields.endsAt!)}`,
        `時數：${hours(ready.durationMinutes)}`,
        `原因：${ready.reason || NO_REASON}`,
      ] : null,
      submit: ready ? (actor) => createHrLeaveRequest(db, { ...ready.interval, leaveTypeId: ready.leaveType.id, reason: ready.reason }, actor) : null,
    };
  },
};

const overtimeHandler: DraftKindHandler = {
  async merge(db, userId, previous, input) {
    assertOwnFields(input, ["startsAt", "endsAt", "reason"], "加班");
    const next = { ...previous };
    const intervalChanged = mergeInterval(next, input);
    mergeReason(next, input, "加班");
    const request = overtimeInput(userId, next);
    if (request && intervalChanged) await checkHrSelfOvertimeRequest(db, request);
    return next;
  },
  async detail(db, userId, fields) {
    const request = overtimeInput(userId, fields);
    const { value, problem } = request ? await problemOf(() => checkHrSelfOvertimeRequest(db, request)) : { value: null, problem: null };
    const durationMinutes = value?.durationMinutes ?? null;
    const reason = fields.reason?.trim() ?? "";
    const missing = [
      ...(fields.startsAt ? [] : ["startsAt"]),
      ...(fields.endsAt ? [] : ["endsAt"]),
    ];
    const ready = request && durationMinutes !== null ? { request: { ...request, reason }, durationMinutes, reason } : null;
    return {
      fields: { startsAt: fields.startsAt ?? null, endsAt: fields.endsAt ?? null, durationMinutes, settlement: "加班費", reason: reason || null },
      missing, optional: reason ? [] : ["reason"], problem,
      cardLines: ready ? [
        `開始：${withWeekday(fields.startsAt!)}`,
        `結束：${withWeekday(fields.endsAt!)}`,
        `時數：${hours(ready.durationMinutes)}`,
        "結算：加班費",
        `原因：${ready.reason || NO_REASON}`,
      ] : null,
      submit: ready ? (actor) => createHrOvertimeRequest(db, ready.request, actor) : null,
    };
  },
};

function clockCorrectionInput(userId: string, fields: HrRequestDraftFields): HrSelfClockCorrectionInput | null {
  if (!fields.clockAt || (fields.clockEvent !== "clock_in" && fields.clockEvent !== "clock_out")) return null;
  return {
    employeeUserId: userId,
    // 補打卡的日期就是那一次打卡在台北的日期；HR 那邊會驗兩者一致。
    correctionDate: fields.clockAt.slice(0, 10),
    requestedEventKind: fields.clockEvent,
    requestedAt: taipeiMinute(fields.clockAt, "打卡時間"),
    reason: fields.reason ?? "",
  };
}

const clockCorrectionHandler: DraftKindHandler = {
  async merge(db, userId, previous, input) {
    assertOwnFields(input, ["clockEvent", "clockAt", "reason"], "補打卡");
    const next = { ...previous };
    if (input.clockEvent !== undefined) {
      if (!CLOCK_EVENT_LABELS[input.clockEvent]) throw new HrError(400, "請選擇要補的是上班打卡（clock_in）還是下班打卡（clock_out）。");
      next.clockEvent = input.clockEvent;
    }
    if (input.clockAt !== undefined) { taipeiMinute(input.clockAt, "打卡時間"); next.clockAt = input.clockAt; }
    mergeReason(next, input, "補打卡");
    const request = clockCorrectionInput(userId, next);
    if (request && (input.clockAt !== undefined || input.clockEvent !== undefined)) await checkHrSelfClockCorrection(db, request);
    return next;
  },
  async detail(db, userId, fields) {
    const request = clockCorrectionInput(userId, fields);
    const { problem } = request ? await problemOf(() => checkHrSelfClockCorrection(db, request)) : { problem: null };
    const reason = fields.reason?.trim() ?? "";
    const eventLabel = fields.clockEvent ? CLOCK_EVENT_LABELS[fields.clockEvent] ?? null : null;
    // 補打卡的原因是必填，跟 HR 頁面那張表單一樣：審核者要靠它判斷那一次為什麼沒打到。
    const missing = [
      ...(eventLabel ? [] : ["clockEvent"]),
      ...(fields.clockAt ? [] : ["clockAt"]),
      ...(reason ? [] : ["reason"]),
    ];
    const ready = request && !problem && reason ? { ...request, reason } : null;
    return {
      fields: { clockEvent: eventLabel ? fields.clockEvent : null, clockEventLabel: eventLabel, clockAt: fields.clockAt ?? null, reason: reason || null },
      missing, optional: [], problem,
      cardLines: ready ? [
        `類型：${eventLabel}`,
        `時間：${withWeekday(fields.clockAt!)}`,
        `原因：${reason}`,
      ] : null,
      submit: ready ? (actor) => createAndSubmitHrClockCorrection(db, ready, actor) : null,
    };
  },
};

const HANDLERS: Record<HrRequestDraftKind, DraftKindHandler> = { leave: leaveHandler, overtime: overtimeHandler, clock_correction: clockCorrectionHandler };

function handlerFor(kind: string): DraftKindHandler {
  const handler = (HANDLERS as Partial<Record<string, DraftKindHandler>>)[kind];
  if (!handler) throw new HrError(400, `目前只能透過小香申請${Object.values(KIND_LABELS).join("、")}。`);
  return handler;
}

async function draftDetail(db: Database, row: DraftRow, now: number) {
  return handlerFor(row.kind).detail(db, row.userId, parseFields(row), now);
}

function draftView(row: DraftRow, detail: DraftDetail) {
  const kindLabel = KIND_LABELS[row.kind];
  return {
    id: row.id,
    /** 確認按鈕帶著它：員工按的是哪一版的卡片，送出的就必須是哪一版。 */
    revision: row.revision,
    kind: row.kind,
    kindLabel,
    status: detail.cardLines ? "ready" as const : "collecting" as const,
    fields: detail.fields,
    notes: parseFields(row).notes || null,
    missing: detail.missing,
    optional: detail.optional,
    problem: detail.problem,
    ...(detail.leaveTypeOptions ? { leaveTypeOptions: detail.leaveTypeOptions } : {}),
    card: detail.cardLines ? [`${kindLabel}申請（尚未送出）`, ...detail.cardLines].join("\n") : null,
    expiresAt: taipeiMinuteFromUtcWallClock(row.expiresAt),
    timeZone: "Asia/Taipei",
  };
}

export type HrRequestDraftView = ReturnType<typeof draftView>;

/** 讀這段對話進行中的草稿；沒有就是 null。 */
export async function getHrRequestDraft(db: Database, scope: HrRequestDraftScope, now = Date.now()): Promise<HrRequestDraftView | null> {
  const row = await ownDraft(db, scope, now);
  return row ? draftView(row, await draftDetail(db, row, now)) : null;
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
/**
 * 存檔的結果多帶 changed：這一次真的改到的欄位。
 *
 * 模型自己以為都存了，實際上常常漏：員工一句話裡又更正日期又指定假別，它只存了假別，回覆卻照樣說
 * 「已改成…」。changed 讓它（以及聽它複述的員工）看得出來員工想改的那一項到底有沒有進去。
 */
export type HrRequestDraftSaveResult = HrRequestDraftView & { changed: string[] };

export async function saveHrRequestDraft(db: Database, scope: HrRequestDraftScope, input: HrRequestDraftInput, now = Date.now()): Promise<HrRequestDraftSaveResult> {
  const handler = handlerFor(input.kind);
  const kind = input.kind as HrRequestDraftKind;
  await retireExpired(db, scope, now);
  const occupying = await activeDraft(db, scope, now);
  // 佔著位置的是前一個人的草稿：收掉它，現在這個人從空白開始。
  if (occupying && occupying.userId !== scope.userId) await discardHrRequestDrafts(db, scope, now);
  const current = occupying && occupying.userId === scope.userId ? occupying : null;
  if (current && current.kind !== kind) {
    throw new HrError(409, `已經有一張還沒完成的${KIND_LABELS[current.kind]}草稿。請先問員工要繼續那一張，還是取消它；取消後才能開始新的${KIND_LABELS[kind]}申請。`);
  }

  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + DRAFT_TTL_MS).toISOString();
  const write = async (fields: HrRequestDraftFields) => {
    const payloadJson = JSON.stringify(fields);
    if (current) {
      // 用 revision 守門：同一段對話的兩輪並行時，後到的不會靜靜蓋掉先到的。
      const updated = await db.update(assistantHrRequestDrafts)
        .set({ payloadJson, expiresAt, updatedAt: nowIso, revision: sql`${assistantHrRequestDrafts.revision} + 1` })
        .where(and(eq(assistantHrRequestDrafts.id, current.id), eq(assistantHrRequestDrafts.revision, current.revision), eq(assistantHrRequestDrafts.status, "open")))
        .returning({ id: assistantHrRequestDrafts.id });
      if (!updated.length) throw new HrError(409, "草稿剛剛被更新或取消了，請重新讀取草稿再繼續。");
      return;
    }
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
  };

  const previous = current ? parseFields(current) : {};
  // notes 是白話，不經過 handler 的規則：先併好，下面欄位不合法時它仍然要留得下來。
  const withNotes: HrRequestDraftFields = { ...previous };
  if (input.notes !== undefined) {
    const notes = input.notes.trim();
    if (notes.length > NOTES_MAX_LENGTH) throw new HrError(400, `備註不可超過 ${NOTES_MAX_LENGTH} 字。`);
    if (notes) withNotes.notes = notes; else delete withNotes.notes;
  }
  let next: HrRequestDraftFields;
  try {
    next = await handler.merge(db, scope.userId, withNotes, input, now);
  } catch (error) {
    // 欄位不合法時那些欄位整次不存（不變條件 3），但「員工正在申請這一種」與模型寫的備註要留下來：
    // 這一輪是 HR 回合，不留 transcript。什麼都不留的話，下一輪模型連他在申請什麼都不知道，
    // 員工被拒絕的那句話也跟著不見。
    if (error instanceof HrError && (!current || input.notes !== undefined)) await write(withNotes).catch(() => undefined);
    throw error;
  }
  await write(next);
  const saved = await ownDraft(db, scope, now);
  if (!saved) throw new HrError(409, "草稿剛剛被取消了，請重新開始。");
  const changed = ([...FIELD_KEYS, "notes"] as const).filter((key) => (previous[key] ?? "") !== (next[key] ?? ""));
  return { ...draftView(saved, await draftDetail(db, saved, now)), changed };
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
 * - 建立函式丟出錯誤、但那次寫入其實已經進了資料庫（結果不明的失敗）：草稿會退回 open，員工可能再送一次。
 *   這時擋住第二張的是 HR 自己的規則——請假與加班的時段重疊、補打卡的同一個時間點——不是這裡。
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
  const detail = await draftDetail(db, row, now);
  const card = draftView(row, detail).card;
  if (!detail.submit || !card) return { outcome: "not_ready", kindLabel, problem: detail.problem };
  if (!(await claim("submitted")).length) {
    const [latest] = await db.select({ status: assistantHrRequestDrafts.status }).from(assistantHrRequestDrafts).where(eq(assistantHrRequestDrafts.id, row.id)).limit(1);
    return latest?.status === "submitted" ? { outcome: "already_submitted", kindLabel } : { outcome: "changed", kindLabel };
  }
  let requestId: string;
  try {
    requestId = (await detail.submit(input.actor)).id;
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
  return { outcome: "submitted", kindLabel, requestId, card };
}
