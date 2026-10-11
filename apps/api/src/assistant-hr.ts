import { can, HR_TOOL_TOKEN_TTL_SECONDS, signHrToolToken, verifyHrToolToken, type AuthUser, type HrToolContext, type HrToolIdentity } from "@rueisiang/auth";
import {
  cancelHrRequestDraft, findAssistantLineGroup, findLineAccountBinding, findLineAccountBindingByUser, getAssistantLineChannel, getHrRequestDraft, getHrSelfToolAnnualLeave,
  isHrAdministrator, isHrEmployee, listAssistantToolConfigs, listHrSelfToolLeaveRequests, listHrSelfToolOvertimeRequests, listHrSelfToolSchedule,
  loadAuthUser, resolveLineToolKeys, saveHrRequestDraft,
  type Database, type HrRequestDraftConfirmation, type HrRequestDraftInput, type HrRequestDraftScope, type HrSelfLeaveQuery, type HrSelfOvertimeQuery, type HrSelfScheduleQuery,
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
    return { draft: await getHrRequestDraft(this.db, this.draftScope(userId)) };
  }

  async saveRequestDraft(input: HrRequestDraftInput) {
    const userId = await this.requireToken("hr_request_draft_save");
    return { draft: await saveHrRequestDraft(this.db, this.draftScope(userId), input) };
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
      // 卡片第一行是「（尚未送出）」的標題，送出後不能原樣貼回去。
      return [`已送出${outcome.kindLabel}申請，等候審核。`, ...outcome.card.split("\n").slice(1)].join("\n");
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

/**
 * 每一輪開始前給模型的提醒：這段對話有一張講到一半的草稿。
 * 只講「有」跟「是哪一種」——這句會進 system prompt，草稿內容要模型自己用工具去讀。
 */
export function hrRequestDraftPromptHint(hint: { kindLabel: string } | null): string[] {
  return hint
    ? [`這位員工有一張還沒完成的${hint.kindLabel}申請草稿。回答前先呼叫 hr_authorize 與 hr_request_draft_get 讀出草稿，接著問還缺的欄位；員工如果想做別的事，提醒他這張草稿還在，問他要繼續還是取消。`]
    : [];
}
