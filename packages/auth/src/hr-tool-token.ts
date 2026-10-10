import { signPayload, verifyPayload, type Expiring } from "./signed.js";

export interface HrToolContext {
  surface: "line" | "sandbox";
  actorUserId?: string;
  assistantKey: string;
  channelKey: string;
  conversationId: string;
  contextGeneration: string;
  runId: string;
  lineLoginChannelId: string;
  lineUserId: string;
}

export interface HrToolIdentity {
  userId: string;
  linkVersion: string;
}

interface HrToolClaims extends Expiring, HrToolContext, HrToolIdentity {
  purpose: "assistant_hr_self_read";
}

export const HR_TOOL_TOKEN_TTL_SECONDS = 300;
const CONTEXT_FIELDS = ["surface", "actorUserId", "assistantKey", "channelKey", "conversationId", "contextGeneration", "runId", "lineLoginChannelId", "lineUserId"] as const;

export async function signHrToolToken(context: HrToolContext, identity: HrToolIdentity, secret: string, now = Date.now()): Promise<string> {
  return signPayload<HrToolClaims>({
    ...context,
    ...identity,
    purpose: "assistant_hr_self_read",
    expiresAt: Math.floor(now / 1000) + HR_TOOL_TOKEN_TTL_SECONDS,
  }, secret);
}

export async function verifyHrToolToken(token: string | undefined, context: HrToolContext, secret: string, now = Date.now()): Promise<HrToolIdentity | null> {
  const claims = await verifyPayload<HrToolClaims>(token, secret, now);
  if (!claims || claims.purpose !== "assistant_hr_self_read"
    || !Number.isFinite(claims.expiresAt)
    || claims.expiresAt > Math.floor(now / 1000) + HR_TOOL_TOKEN_TTL_SECONDS
    || typeof claims.userId !== "string" || !claims.userId
    || typeof claims.linkVersion !== "string" || !claims.linkVersion
    || CONTEXT_FIELDS.some((key) => claims[key] !== context[key])) return null;
  return { userId: claims.userId, linkVersion: claims.linkVersion };
}
