import { can, HR_TOOL_TOKEN_TTL_SECONDS, signHrToolToken, verifyHrToolToken, type AuthUser, type HrToolContext, type HrToolIdentity } from "@rueisiang/auth";
import {
  findAssistantLineGroup, findLineAccountBinding, findLineAccountBindingByUser, getAssistantLineChannel, getHrSelfToolAnnualLeave,
  isHrAdministrator, isHrEmployee, listAssistantToolConfigs, listHrSelfToolLeaveRequests, loadAuthUser, resolveLineToolKeys,
  type Database, type HrSelfLeaveQuery,
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
  if (!lineLoginChannelId || env.HR_ASSISTANT_CHANNEL_KEY !== input.channelKey) {
    throw new HrSelfToolError("這個 LINE 帳號尚未開通 HR 本人查詢。" );
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
    return { authorized: true, access: "本人假單與當期特休唯讀", expiresInSeconds: 300 };
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

export async function isHrSandboxActor(db: Database, user: AuthUser): Promise<boolean> {
  return can(user, "assistant:sandbox:write") && await isHrAdministrator(db, user.id);
}

export async function assertHrSandboxRunAllowed(db: Database, env: Env, input: PiSandboxAgentRunRequest) {
  // 操作者先過關，才允許碰任何目標員工或 LINE 綁定。
  const actor = await loadAuthUser(db, { id: input.actorUserId });
  if (!actor || !await isHrSandboxActor(db, actor)) throw new HrSelfToolError("HR 模擬本人測試僅限啟用中的平台管理者。" );
  if (!input.hrSandboxUserId?.trim() || input.sandboxSessionId !== null
    || input.conversationId !== input.runId || input.contextGeneration !== input.runId
    || input.attachments?.length || !input.toolKeys.includes("hr_authorize")
    || input.toolKeys.some((key) => !isHrToolKey(key))) {
    throw new HrSelfToolError("HR 模擬本人測試必須是獨立單輪，且只能使用 HR 工具，不接受 session 或圖片。" );
  }
  if (!env.LINE_LIFF_CHANNEL_ID?.trim()) throw new HrSelfToolError("平台尚未設定 LINE Login channel，無法測試既有員工綁定。" );
  const tools = await listAssistantToolConfigs(db);
  if (input.toolKeys.some((key) => !tools.some((tool) => tool.key === key && (tool.status === "enabled" || tool.status === "development")))) {
    throw new HrSelfToolError("本輪 HR 測試工具已停用，請重新選擇。" );
  }
}

async function authorizedSandboxIdentity(db: Database, env: Env, input: PiSandboxAgentRunRequest, expected?: HrToolIdentity) {
  await assertHrSandboxRunAllowed(db, env, input);
  const userId = input.hrSandboxUserId!;
  const binding = await findLineAccountBindingByUser(db, userId, env.LINE_LIFF_CHANNEL_ID!.trim());
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

export class SandboxHrSelfService extends HrSelfService {
  static async create(db: Database, env: Env, input: PiSandboxAgentRunRequest) {
    const binding = await authorizedSandboxIdentity(db, env, input);
    const context: HrToolContext = {
      surface: "sandbox", actorUserId: input.actorUserId,
      assistantKey: input.assistantKey, channelKey: HR_SANDBOX_CHANNEL_KEY,
      conversationId: input.runId, contextGeneration: input.contextGeneration,
      runId: input.runId, lineLoginChannelId: env.LINE_LIFF_CHANNEL_ID!.trim(), lineUserId: binding.lineUserId,
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
