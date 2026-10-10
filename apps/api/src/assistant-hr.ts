import { HR_TOOL_TOKEN_TTL_SECONDS, signHrToolToken, verifyHrToolToken, type HrToolContext, type HrToolIdentity } from "@rueisiang/auth";
import {
  findAssistantLineGroup, findLineAccountBinding, getAssistantLineChannel, getHrSelfToolAnnualLeave,
  isHrEmployee, listHrSelfToolLeaveRequests, loadAuthUser, resolveLineToolKeys,
  type Database, type HrSelfLeaveQuery,
} from "@rueisiang/db";
import { isHrToolKey, type HrSelfToolService } from "@rueisiang/tools";
import type { Env } from "./env.js";
import type { PiLineAgentContext, PiLineAgentRunRequest } from "./pi-agent-contract.js";

export class HrSelfToolError extends Error {}

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

export class LineHrSelfService implements HrSelfToolService {
  private token?: string;
  private identity?: HrToolIdentity;
  private expiresAt?: number;
  private readonly usedKeys = new Set<string>();
  private readonly context: HrToolContext;

  constructor(private readonly db: Database, private readonly env: Env, private readonly input: PiLineAgentRunRequest) {
    this.context = requirePrivateContext(env, input);
  }

  get authorization(): HrDeliveryAuthorization | undefined {
    return this.identity && this.expiresAt !== undefined
      ? { ...this.identity, expiresAt: this.expiresAt, runId: this.context.runId }
      : undefined;
  }

  async authorize() {
    const identity = await authorizedIdentity(this.db, this.env, this.input, [...this.usedKeys], this.identity);
    const now = Date.now();
    this.token = await signHrToolToken(this.context, identity, this.env.AUTH_SESSION_SECRET, now);
    this.expiresAt = Math.floor(now / 1000) + HR_TOOL_TOKEN_TTL_SECONDS;
    this.identity = identity;
    return { authorized: true, access: "本人假單與當期特休唯讀", expiresInSeconds: 300 };
  }

  private async requireToken(key: string) {
    const identity = await verifyHrToolToken(this.token, this.context, this.env.AUTH_SESSION_SECRET);
    if (!identity) throw new HrSelfToolError("請先呼叫 hr_authorize 取得本輪本人授權；過期後需重新授權。" );
    await authorizedIdentity(this.db, this.env, this.input, [key], identity);
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
    await authorizedIdentity(this.db, this.env, this.input, [...this.usedKeys], identity);
  }
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
