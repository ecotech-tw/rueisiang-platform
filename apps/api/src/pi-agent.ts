import type { AppEnv } from "./env.js";
import type { AssistantToolCall } from "@rueisiang/assistant";
import type {
  PiLineAgentContext,
  PiLineAgentResetResponse,
  PiLineAgentRunRequest,
  PiLineAgentRunResponse,
  PiSandboxAgentRunRequest,
  PiSandboxAgentRunResponse,
} from "./pi-agent-contract.js";

export const DEFAULT_PI_CODEX_MODEL = "gpt-5.4-mini";

export class PiAgentStaleSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiAgentStaleSessionError";
  }
}

export class PiAgentRequestError extends Error {
  readonly status: number;
  readonly toolCalls: AssistantToolCall[];
  readonly permanent: boolean;

  constructor(message: string, status: number, toolCalls: AssistantToolCall[] = [], permanent = false) {
    super(message);
    this.name = "PiAgentRequestError";
    this.status = status;
    this.toolCalls = toolCalls;
    this.permanent = permanent;
  }
}

function parseToolCalls(value: unknown): AssistantToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const call = item as Record<string, unknown>;
    if (
      typeof call.toolKey !== "string"
      || (call.status !== "success" && call.status !== "failed")
      || typeof call.durationMs !== "number"
      || !Number.isFinite(call.durationMs)
    ) return [];
    return [{
      toolKey: call.toolKey,
      status: call.status,
      durationMs: call.durationMs,
      ...(typeof call.args === "object" && call.args !== null ? { args: call.args as Record<string, unknown> } : {}),
      ...(typeof call.errorMessage === "string" ? { errorMessage: call.errorMessage } : {}),
    } satisfies AssistantToolCall];
  });
}

function lineAgentName(input: PiLineAgentContext): string {
  return [input.assistantKey, input.channelKey, input.sourceType, input.lineGroupId].join(":");
}

function sandboxAgentName(input: PiSandboxAgentRunRequest): string {
  return [input.assistantKey, "sandbox", input.actorUserId, input.conversationId].join(":");
}

function agentStub(env: AppEnv["Bindings"], name: string): DurableObjectStub {
  const namespace = env.ASSISTANT_CHAT_AGENT;
  if (!namespace) throw new Error("平台尚未綁定 ASSISTANT_CHAT_AGENT Durable Object。");
  return namespace.getByName(name);
}

async function requestAgent<TResponse>(
  env: AppEnv["Bindings"],
  name: string,
  path: string,
  body: unknown,
): Promise<TResponse> {
  const response = await agentStub(env, name).fetch(new Request(`https://assistant-agent.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const payload = await response.json().catch(() => null) as { error?: unknown; toolCalls?: unknown; permanent?: unknown } | null;
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : "Pi agent 暫時無法回應。";
    if (response.status === 409) throw new PiAgentStaleSessionError(message);
    throw new PiAgentRequestError(message, response.status, parseToolCalls(payload?.toolCalls), payload?.permanent === true);
  }
  return payload as TResponse;
}

export async function runPiLineAgent(
  env: AppEnv["Bindings"],
  input: PiLineAgentRunRequest,
): Promise<PiLineAgentRunResponse> {
  return requestAgent<PiLineAgentRunResponse>(env, lineAgentName(input), "/run", input);
}

export async function runPiSandboxAgent(
  env: AppEnv["Bindings"],
  input: PiSandboxAgentRunRequest,
): Promise<PiSandboxAgentRunResponse> {
  return requestAgent<PiSandboxAgentRunResponse>(env, sandboxAgentName(input), "/run", input);
}

export async function resetPiLineAgent(
  env: AppEnv["Bindings"],
  input: PiLineAgentContext,
): Promise<PiLineAgentResetResponse> {
  return requestAgent<PiLineAgentResetResponse>(env, lineAgentName(input), "/reset", input);
}

/** 不旋轉 access token；設定頁只確認 vault 能解密目前的 credential。 */
export async function piCodexCredentialConfigured(env: AppEnv["Bindings"]): Promise<boolean> {
  return (await piCodexCredentialStatus(env)).configured;
}

export type PiCodexCredentialState = "unconfigured" | "ready" | "needs_reauth";

export interface PiCodexCredentialStatus {
  configured: boolean;
  status: PiCodexCredentialState;
  lastErrorAt: number | null;
}

export async function piCodexCredentialStatus(env: AppEnv["Bindings"]): Promise<PiCodexCredentialStatus> {
  const namespace = env.ASSISTANT_CREDENTIAL_VAULT;
  if (!namespace) return { configured: false, status: "unconfigured", lastErrorAt: null };
  try {
    const response = await namespace.getByName("openai-codex").fetch(new Request(
      "https://assistant-credential.internal/status",
      { method: "POST" },
    ));
    const payload = await response.json().catch(() => null) as {
      configured?: unknown;
      status?: unknown;
      lastErrorAt?: unknown;
    } | null;
    if (!response.ok || payload?.configured !== true) {
      return { configured: false, status: "unconfigured", lastErrorAt: null };
    }
    return {
      configured: true,
      status: payload.status === "needs_reauth" ? "needs_reauth" : "ready",
      lastErrorAt: typeof payload.lastErrorAt === "number" ? payload.lastErrorAt : null,
    };
  } catch {
    return { configured: false, status: "unconfigured", lastErrorAt: null };
  }
}

/** 將新的 Pi／Codex OAuth credential 匯入唯一 vault；成功回應不包含 credential 原值。 */
export async function savePiCodexCredential(
  env: AppEnv["Bindings"],
  credential: string,
): Promise<PiCodexCredentialStatus> {
  const namespace = env.ASSISTANT_CREDENTIAL_VAULT;
  if (!namespace) throw new PiAgentRequestError("平台尚未綁定 ASSISTANT_CREDENTIAL_VAULT Durable Object。", 503);
  const response = await namespace.getByName("openai-codex").fetch(new Request(
    "https://assistant-credential.internal/credential",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
    },
  ));
  const payload = await response.json().catch(() => null) as {
    configured?: unknown;
    status?: unknown;
    lastErrorAt?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : "Codex credential 匯入失敗。";
    throw new PiAgentRequestError(message, response.status);
  }
  return {
    configured: payload?.configured === true,
    status: payload?.status === "needs_reauth" ? "needs_reauth" : "ready",
    lastErrorAt: typeof payload?.lastErrorAt === "number" ? payload.lastErrorAt : null,
  };
}
