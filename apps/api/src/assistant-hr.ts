import { can, HR_TOOL_TOKEN_TTL_SECONDS, signHrToolToken, verifyHrToolToken, type AuthUser, type HrToolContext, type HrToolIdentity } from "@rueisiang/auth";
import {
  cancelHrRequestDraft, findAssistantLineGroup, findLineAccountBinding, findLineAccountBindingByUser, getAssistantLineChannel, getHrRequestDraft, getHrSelfToolAnnualLeave,
  isHrAdministrator, isHrEmployee, listAssistantToolConfigs, listHrSelfToolLeaveRequests, listHrSelfToolOvertimeRequests, listHrSelfToolSchedule,
  loadAuthUser, resolveLineToolKeys, saveHrRequestDraft,
  type Database, type HrRequestDraftConfirmation, type HrRequestWithdrawal, type HrRequestDraftInput, type HrRequestDraftScope, type HrSelfLeaveQuery, type HrSelfOvertimeQuery, type HrSelfScheduleQuery,
} from "@rueisiang/db";
import { isHrToolKey, type HrSelfToolService } from "@rueisiang/tools";
import type { Env } from "./env.js";
import type { PiLineAgentContext, PiLineAgentRunRequest, PiSandboxAgentRunRequest } from "./pi-agent-contract.js";

export class HrSelfToolError extends Error {}

export const HR_SANDBOX_CHANNEL_KEY = "sandbox-hr";

/** 僅在 DO 與本輪 delivery 間傳遞，不給模型或持久化。 */
export interface HrDeliveryAuthorization extends HrToolIdentity {
  expiresAt: number;
  runId: string;
}

function requirePrivateContext(env: Env, input: PiLineAgentContext): HrToolContext {
  // 必須在任何綁定／員工查詢之前拒絕群組，也不使用群組發話者來換取本人授權。
  if (input.sourceType !== "user") throw new HrSelfToolError("HR 授權與查詢僅限 LINE 本人私訊。" );
  const lineLoginChannelId = env.LINE_LIFF_CHANNEL_ID?.trim();
  if (!lineLoginChannelId) {
    throw new HrSelfToolError("LINE HR 員工登入尚未設定。" );
  }
  return {
    surface: "line",
    assistantKey: input.assistantKey, channelKey: input.channelKey,
    conversationId: input.groupRowId, contextGeneration: input.contextGeneration,
    runId: "runId" in input && typeof input.runId === "string" ? input.runId : "delivery",
    lineLoginChannelId, lineUserId: input.lineGroupId,
  };
}

async function authorizedIdentity(db: Database, env: Env, input: PiLineAgentContext, toolKeys: readonly string[], expected?: HrToolIdentity) {
  const context = requirePrivateContext(env, input);
  const [channel, conversation] = await Promise.all([
    getAssistantLineChannel(db, input.assistantKey),
    findAssistantLineGroup(db, { channelKey: input.channelKey, id: input.groupRowId }),
  ]);
  if (!channel?.enabled || channel.channelKey !== input.channelKey
    || !conversation?.enabled || conversation.sourceType !== "user"
    || conversation.lineGroupId !== input.lineGroupId
    || (conversation.contextResetAt ?? "") !== input.contextGeneration) {
    throw new HrSelfToolError("HR 私訊授權已失效，請重新查詢。" );
  }
  const allowed = await resolveLineToolKeys(db, { channelKey: input.channelKey, groupId: input.groupRowId, toolMode: conversation.toolMode });
  if (["hr_authorize", ...toolKeys].some((key) => !allowed.includes(key))) throw new HrSelfToolError("這個私訊目前沒有 HR 工具授權。" );
  const binding = await findLineAccountBinding(db, { channelId: context.lineLoginChannelId, lineUserId: context.lineUserId });
  if (!binding) throw new HrSelfToolError("請先從 LINE HR 員工頁登入平台並完成帳號綁定，再回來查詢。" );
  if (expected && (binding.userId !== expected.userId || binding.linkVersion !== expected.linkVersion)) {
    throw new HrSelfToolError("員工綁定已變更，本輪 HR 授權失效，請重新查詢。" );
  }
  const user = await loadAuthUser(db, { id: binding.userId });
  if (!user || user.status !== "active" || !await isHrEmployee(db, user.id)) {
    throw new HrSelfToolError("HR 本人查詢僅限帳號啟用的在職員工。" );
  }
  return binding;
}

class HrSelfService implements HrSelfToolService {
  private token?: string;
  private identity?: HrToolIdentity;
  private expiresAt?: number;
  private readonly usedKeys = new Set<string>();
  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly context: HrToolContext,
    private readonly resolveIdentity: (toolKeys: readonly string[], expected?: HrToolIdentity) => Promise<HrToolIdentity>,
  ) {}

  get authorization(): HrDeliveryAuthorization | undefined {
    return this.identity && this.expiresAt !== undefined
      ? { ...this.identity, expiresAt: this.expiresAt, runId: this.context.runId }
      : undefined;
  }

  async authorize() {
    const identity = await this.resolveIdentity([...this.usedKeys], this.identity);
    const now = Date.now();
    this.token = await signHrToolToken(this.context, identity, this.env.AUTH_SESSION_SECRET, now);
    this.expiresAt = Math.floor(now / 1000) + HR_TOOL_TOKEN_TTL_SECONDS;
    this.identity = identity;
    return { authorized: true, access: "本人假單、特休、加班申請與班表唯讀；可以存取本人的申請草稿，但不能送出申請", expiresInSeconds: 300 };
  }

  private async requireToken(key: string) {
    const identity = await verifyHrToolToken(this.token, this.context, this.env.AUTH_SESSION_SECRET);
    if (!identity) throw new HrSelfToolError("請先呼叫 hr_authorize 取得本輪本人授權；過期後需重新授權。" );
    await this.resolveIdentity([key], identity);
    this.usedKeys.add(key);
    return identity.userId;
  }

  async leaveRequests(query: HrSelfLeaveQuery) {
    const userId = await this.requireToken("hr_get_my_leave_requests");
    return listHrSelfToolLeaveRequests(this.db, userId, query);
  }

  async annualLeave() {
    const userId = await this.requireToken("hr_get_my_annual_leave");
    return getHrSelfToolAnnualLeave(this.db, userId);
  }

  async overtimeRequests(query: HrSelfOvertimeQuery) {
    const userId = await this.requireToken("hr_get_my_overtime_requests");
    return listHrSelfToolOvertimeRequests(this.db, userId, query);
  }

  async schedule(query: HrSelfScheduleQuery) {
    const userId = await this.requireToken("hr_get_my_schedule");
    return listHrSelfToolSchedule(this.db, userId, query);
  }

  /** 草稿屬於這段對話與這位已授權的員工；兩者都由執行環境決定，模型傳不進來。 */
  private draftScope(userId: string): HrRequestDraftScope {
    return {
      assistantKey: this.context.assistantKey,
      surface: this.context.surface,
      channelKey: this.context.surface === "line" ? this.context.channelKey : null,
      conversationKey: this.context.conversationId,
      userId,
      actorUserId: this.context.actorUserId ?? null,
    };
  }

  async requestDraft() {
    const userId = await this.requireToken("hr_request_draft_get");
    return { draft: draftForModel(await getHrRequestDraft(this.db, this.draftScope(userId))) };
  }

  async saveRequestDraft(input: HrRequestDraftInput) {
    const userId = await this.requireToken("hr_request_draft_save");
    return { draft: draftForModel(await saveHrRequestDraft(this.db, this.draftScope(userId), input)) };
  }

  async cancelRequestDraft() {
    const userId = await this.requireToken("hr_request_draft_cancel");
    return cancelHrRequestDraft(this.db, this.draftScope(userId));
  }

  async assertStillAuthorized() {
    if (!this.identity) return;
    const identity = await verifyHrToolToken(this.token, this.context, this.env.AUTH_SESSION_SECRET);
    if (!identity) throw new HrSelfToolError("本輪 HR 授權已過期，請重新查詢。" );
    await this.resolveIdentity([...this.usedKeys], identity);
  }
}

export class LineHrSelfService extends HrSelfService {
  constructor(db: Database, env: Env, input: PiLineAgentRunRequest) {
    super(db, env, requirePrivateContext(env, input), (keys, expected) => authorizedIdentity(db, env, input, keys, expected));
  }
}

/** HR 工具能不能出現在這一輪的唯一規則：路由拿它回 400，DO 在執行前再用同一份擋一次。 */
export function hrToolKeysProblem(toolKeys: readonly string[], hasSubject: boolean): string | null {
  const hrToolKeys = toolKeys.filter(isHrToolKey);
  if (!hrToolKeys.length) return null;
  if (!hasSubject) return "HR 工具需要先選擇要模擬的員工。";
  if (!hrToolKeys.includes("hr_authorize")) return "HR 工具必須連同 hr_authorize 一起提供。";
  return null;
}

function requireLineLoginChannelId(env: Env): string {
  const channelId = env.LINE_LIFF_CHANNEL_ID?.trim();
  if (!channelId) throw new HrSelfToolError("平台尚未設定 LINE Login channel，無法測試既有員工綁定。" );
  return channelId;
}

export async function isHrSandboxActor(db: Database, user: AuthUser): Promise<boolean> {
  return can(user, "assistant:sandbox:write") && await isHrAdministrator(db, user.id);
}

async function assertHrSandboxActor(db: Database, actorUserId: string) {
  const actor = await loadAuthUser(db, { id: actorUserId });
  if (!actor || !await isHrSandboxActor(db, actor)) throw new HrSelfToolError("HR 模擬本人測試僅限啟用中的平台管理者。" );
}

/** 被模擬的那位員工此刻還能不能被查：有綁定、帳號啟用、在職。 */
async function sandboxSubjectBinding(db: Database, env: Env, userId: string, expected?: HrToolIdentity) {
  const binding = await findLineAccountBindingByUser(db, userId, requireLineLoginChannelId(env));
  if (!binding) throw new HrSelfToolError("這位員工尚未完成目前 LINE Login channel 的帳號綁定。" );
  if (expected && (binding.userId !== expected.userId || binding.linkVersion !== expected.linkVersion)) {
    throw new HrSelfToolError("員工綁定已變更，本輪 HR 授權失效，請重新查詢。" );
  }
  const user = await loadAuthUser(db, { id: userId });
  if (!user || user.status !== "active" || !await isHrEmployee(db, userId)) {
    throw new HrSelfToolError("HR 本人查詢僅限帳號啟用的在職員工。" );
  }
  return binding;
}

/**
 * 一段對話查過某位員工之後，他的資料就留在上下文裡，之後每一輪都能被模型複述——不管那一輪有沒有帶模擬對象、
 * 有沒有呼叫 HR 工具。所以只要對話裡有他，每一輪都用查詢當下的同一組條件重驗操作者與這位員工。
 */
export async function assertHrSandboxSubjectStillAllowed(db: Database, env: Env, actorUserId: string, subjectUserId: string) {
  try {
    await assertHrSandboxActor(db, actorUserId);
    await sandboxSubjectBinding(db, env, subjectUserId);
  } catch (error) {
    if (!(error instanceof HrSelfToolError)) throw error;
    throw new HrSelfToolError(`這段對話含模擬本人查到的 HR 資料，但授權已失效（${error.message}）請清除對話。`);
  }
}

export async function assertHrSandboxRunAllowed(db: Database, env: Env, input: PiSandboxAgentRunRequest) {
  // 操作者先過關，才允許碰任何目標員工或 LINE 綁定。
  await assertHrSandboxActor(db, input.actorUserId);
  if (!input.hrSandboxUserId?.trim()) throw new HrSelfToolError("請先選擇要模擬的員工。" );
  // 模擬本人可以跟一般工具、session 與圖片混用；這裡只管 HR 工具自己的前提，一般工具由 authorizedSandboxTool 把關。
  const problem = hrToolKeysProblem(input.toolKeys, true);
  if (problem) throw new HrSelfToolError(problem);
  const hrToolKeys = input.toolKeys.filter(isHrToolKey);
  // 沒帶 HR 工具的回合用不到綁定；這時擋下來會讓只測一般工具的人整輪失敗。
  if (!hrToolKeys.length) return;
  requireLineLoginChannelId(env);
  const tools = await listAssistantToolConfigs(db);
  if (hrToolKeys.some((key) => !tools.some((tool) => tool.key === key && (tool.status === "enabled" || tool.status === "development")))) {
    throw new HrSelfToolError("本輪 HR 測試工具已停用，請重新選擇。" );
  }
}

async function authorizedSandboxIdentity(db: Database, env: Env, input: PiSandboxAgentRunRequest, expected?: HrToolIdentity) {
  await assertHrSandboxRunAllowed(db, env, input);
  return sandboxSubjectBinding(db, env, input.hrSandboxUserId!, expected);
}

export class SandboxHrSelfService extends HrSelfService {
  static async create(db: Database, env: Env, input: PiSandboxAgentRunRequest) {
    const binding = await authorizedSandboxIdentity(db, env, input);
    const context: HrToolContext = {
      surface: "sandbox", actorUserId: input.actorUserId,
      assistantKey: input.assistantKey, channelKey: HR_SANDBOX_CHANNEL_KEY,
      conversationId: input.conversationId, contextGeneration: input.contextGeneration,
      runId: input.runId, lineLoginChannelId: requireLineLoginChannelId(env), lineUserId: binding.lineUserId,
    };
    return new SandboxHrSelfService(db, env, context, async (_keys, expected) => {
      const current = await authorizedSandboxIdentity(db, env, input, expected ?? binding);
      return current;
    });
  }
}

export async function assertHrSandboxDeliveryAuthorized(db: Database, env: Env, input: PiSandboxAgentRunRequest, identity?: HrDeliveryAuthorization) {
  await assertHrSandboxRunAllowed(db, env, input);
  if (!identity) return;
  const now = Math.floor(Date.now() / 1000);
  if (identity.userId !== input.hrSandboxUserId || identity.runId !== input.runId
    || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= now || identity.expiresAt > now + HR_TOOL_TOKEN_TTL_SECONDS) {
    throw new HrSelfToolError("本輪 HR 授權已過期或不屬於此回覆，請重新查詢。" );
  }
  await authorizedSandboxIdentity(db, env, input, identity);
}

export async function assertHrLineDeliveryAuthorized(db: Database, env: Env, input: PiLineAgentContext & { runId: string }, identity: HrDeliveryAuthorization, toolKeys: readonly string[]) {
  requirePrivateContext(env, input);
  const now = Math.floor(Date.now() / 1000);
  if (identity.runId !== input.runId || !Number.isFinite(identity.expiresAt)
    || identity.expiresAt <= now || identity.expiresAt > now + HR_TOOL_TOKEN_TTL_SECONDS) {
    throw new HrSelfToolError("本輪 HR 授權已過期或不屬於此回覆，請重新查詢。" );
  }
  await authorizedIdentity(db, env, input, toolKeys.filter(isHrToolKey), identity);
}

/**
 * 員工按下確認卡片的按鈕時，這個人是誰。
 *
 * 按鈕不經過模型，但身分與授權的檢查必須跟 HR 工具是同一套（authorizedIdentity）：私訊、channel 與對話啟用、
 * 這個私訊被授權使用草稿工具、LINE 綁定有效、帳號啟用且在職。工具被停用或授權被收回，按鈕也跟著失效。
 */
export async function resolveLineHrRequestActor(db: Database, env: Env, input: PiLineAgentContext): Promise<{ id: string; email: string }> {
  const binding = await authorizedIdentity(db, env, input, ["hr_request_draft_save"]);
  const user = await loadAuthUser(db, { id: binding.userId });
  if (!user) throw new HrSelfToolError("HR 本人查詢僅限帳號啟用的在職員工。" );
  return { id: user.id, email: user.email };
}

/** 按下確認卡片之後回給員工的話。固定句子，不經過模型：這時候講錯一個字（例如把沒送出說成送出）代價最高。 */
export function hrRequestDraftConfirmationReply(outcome: HrRequestDraftConfirmation): string {
  switch (outcome.outcome) {
    case "submitted":
      // 內容在後面接的那張「已送出」卡片上，這裡不再重複一次。
      return `已送出${outcome.kindLabel}申請，等候審核。`;
    case "cancelled":
      return `已取消這張${outcome.kindLabel}草稿，沒有送出任何申請。`;
    case "already_submitted":
      return `這張${outcome.kindLabel}申請已經送出過了，不會重複送出。`;
    case "changed":
      return `這張卡片的內容後來有更新，請以最新的${outcome.kindLabel}確認卡片為準。`;
    case "not_ready":
      return `目前還不能送出這張${outcome.kindLabel}申請：${outcome.problem ?? "資料還不完整"}請告訴我要怎麼修改。`;
    case "rejected":
      return `沒有送出${outcome.kindLabel}申請：${outcome.message}`;
    case "gone":
      return "這張申請草稿已經不在了（可能已經取消，或超過 24 小時沒有更新）。需要的話請重新跟我說一次。";
  }
}

/** 按下「已送出」卡片上的取消之後回給員工的話。一樣是固定句子，不經過模型。 */
export function hrRequestWithdrawalReply(outcome: HrRequestWithdrawal): string {
  switch (outcome.outcome) {
    case "withdrawn":
      return `已取消這張${outcome.kindLabel}申請。`;
    case "already_withdrawn":
      return `這張${outcome.kindLabel}申請已經取消了。`;
    case "reviewed":
      return `這張${outcome.kindLabel}申請已經審核過了，不能在這裡取消。需要更動請到 HR 頁面處理。`;
    case "rejected":
      return `沒有取消${outcome.kindLabel}申請：${outcome.message}`;
    case "gone":
      return "找不到這張申請，沒有取消任何東西。請到 HR 頁面確認。";
  }
}

/**
 * 這一輪拿得到草稿工具時，每一輪都放進 system prompt 的規則，加上「現在有沒有草稿」。
 *
 * 規則的核心是「先存，再複述」。LINE 的 HR 回合不留 transcript：模型這一輪聽到、卻沒有存進草稿的東西，
 * 下一輪就不存在了。原本的說明要模型「日期先跟員工確認再存」，實機上的結果是它問完「是 10/20 嗎」，
 * 下一輪連員工講過 09:00–12:00 都不記得，對話永遠湊不齊。所以改成：聽到就存，存完把存進去的內容念給員工聽，
 * 請他有錯再更正——更正也只是再存一次。
 *
 * 實機上另一種漏法是「一句話兩件事只做一件」：員工更正日期又指定假別，模型只存了假別，卻回覆「已改成…」，
 * 錯的日期就這樣進了確認卡片。所以規則要它逐項列出來、看存檔回傳的 changed 自己核對，並明講哪些沒變；
 * 日期則直接給一張這週與下週的日曆（hrRequestDraftCalendar），不讓它自己推算星期。
 *
 * now 由路由傳進來，跟同一輪 runtimeContextInstruction 用同一個時間：各取各的，跨午夜的那一輪會一邊說
 * 今天 3/1、一邊的日曆寫今天 3/2。
 *
 * 放在 system prompt 而不只寫在工具說明：工具說明是「要用這個工具時怎麼用」，而這裡要的是模型在
 * 員工一開口說要申請時就知道該先開草稿。有沒有草稿只講「有」與種類，內容要模型自己用工具去讀。
 */
/** cardRows 是排 LINE 卡片用的，內容跟 card 一模一樣：不回給模型，一千字的原因不必在工具結果裡出現兩次。 */
function draftForModel<T extends { cardRows: unknown }>(draft: T | null) {
  if (!draft) return null;
  const { cardRows: _cardRows, ...rest } = draft;
  return rest;
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/**
 * 這週與下週每一天是幾月幾號，直接列給模型查。
 *
 * 模型拿得到今天的日期與星期，但從那裡推「這週二」「下週四」是幾號很容易算錯，而算錯的日期會一路
 * 進到確認卡片。週從週一算起：週一凌晨說的「這週二」是明天，不是八天後。
 */
export function hrRequestDraftCalendar(now: number): string {
  // 台北沒有日光節約時間，固定 UTC+8：直接平移再用 UTC 的欄位讀，不靠 Intl 在各 runtime 的輸出格式。
  const todayMs = Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000;
  const today = new Date(todayMs).toISOString().slice(0, 10);
  const mondayMs = todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * 86_400_000;
  const day = (offset: number) => {
    const date = new Date(mondayMs + offset * 86_400_000);
    const text = `${date.getUTCMonth() + 1}/${date.getUTCDate()}（週${WEEKDAY_LABELS[date.getUTCDay()]}）`;
    return date.getTime() === todayMs ? `${text}今天` : text;
  };
  const week = (start: number) => Array.from({ length: 7 }, (_, index) => day(start + index)).join("、");
  return [
    `今天是 ${today}（週${WEEKDAY_LABELS[new Date(todayMs).getUTCDay()]}）。`,
    `這週：${week(0)}`,
    `下週：${week(7)}`,
    "員工說「這週二」「下週四」「明天」「後天」時照上面查，不要自己推算星期；查不到的（更遠的日期）才自己算，並把算出來的幾月幾號星期幾念給他確認。",
  ].join("\n");
}

export function hrRequestDraftPromptRules(available: boolean, hint: { kindLabel: string } | null, now: number): string[] {
  if (!available) return [];
  return [
    [
      "員工可以用講的準備請假、加班、補打卡申請，進度存在「申請草稿」裡。你在這段對話裡不會記得前幾輪講過的申請內容：這一輪沒有存進草稿的東西，下一輪就不見了。所以：",
      "1. 員工一說要申請（例如「我想請假」），就先呼叫 hr_authorize，再呼叫 hr_request_draft_save 開草稿；只知道是哪一種申請也要存。",
      "2. 之後每一輪，員工講到的任何內容（日期、時間、假別、原因）都先呼叫 hr_request_draft_save 存進去，再回覆。不要先問「是不是這樣」等他回答才存——等他回答時你已經不記得了。他同時問了別的事（例如特休剩幾天）也一樣：先存草稿，再去查。",
      "   欄位只收完整的日期加時間。他只講了一半（有日期沒時間、有時間沒日期），或 hr_request_draft_save 回了錯誤，就把他講的內容寫進 notes 存起來——放不進欄位不是不存的理由。",
      "3. 一句話裡常常不只一件事（「不是，是這週二才對。另外我想用特休」是兩件：改日期、選假別）。存之前把他這一輪講的每一件事列出來，全部放進同一次存檔，一件都不能漏。他用「不是…是…」「…才對」「改成…」「我是說…」更正申請內容時，更正後的值一定要存；他只是在問問題或說不申請了，就不是更正。只改日期時，原本的時間要跟著新日期一起重存（開始與結束都要）。",
      "4. 存完看工具回傳的 changed（這一次真的改到的欄位）與草稿現在的內容。他想改的那一項不在 changed 裡、草稿裡的值也不是他要的，就是你漏了：補存一次，只補一次。草稿裡的值已經是他要的（他只是重講一遍）就不用再存。",
      "5. 回覆時把草稿現在的內容念給他聽（日期要講幾月幾號星期幾），並明講這一輪改了什麼、哪些沒有變，請他有錯就直接說；他更正就再存一次。",
      "6. 然後只問一件還缺的事。",
    ].join("\n"),
    hrRequestDraftCalendar(now),
    hint
      ? `這位員工有一張還沒完成的${hint.kindLabel}申請草稿。回答前先呼叫 hr_authorize 與 hr_request_draft_get 讀出草稿，再處理他這一輪講的內容；員工如果想做別的事，提醒他這張草稿還在，問他要繼續還是取消。`
      : "這段對話目前沒有進行中的申請草稿。",
  ];
}
