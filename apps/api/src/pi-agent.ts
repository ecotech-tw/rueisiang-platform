import type { AppEnv } from "./env.js";
import type {
  PiLineAgentContext,
  PiLineAgentResetResponse,
  PiLineAgentRunRequest,
  PiLineAgentRunResponse,
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

  constructor(message: string, status: number) {
    super(message);
    this.name = "PiAgentRequestError";
    this.status = status;
  }
}

function agentName(input: PiLineAgentContext): string {
  return [input.assistantKey, input.channelKey, input.sourceType, input.lineGroupId].join(":");
}

function agentStub(env: AppEnv["Bindings"], input: PiLineAgentContext): DurableObjectStub {
  const namespace = env.ASSISTANT_CHAT_AGENT;
  if (!namespace) throw new Error("平台尚未綁定 ASSISTANT_CHAT_AGENT Durable Object。");
  return namespace.getByName(agentName(input));
}

async function requestAgent<TResponse>(
  env: AppEnv["Bindings"],
  input: PiLineAgentContext,
  path: string,
  body: unknown,
): Promise<TResponse> {
  const response = await agentStub(env, input).fetch(new Request(`https://assistant-agent.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : "Pi agent 暫時無法回應。";
    if (response.status === 409) throw new PiAgentStaleSessionError(message);
    throw new PiAgentRequestError(message, response.status);
  }
  return payload as TResponse;
}

export async function runPiLineAgent(
  env: AppEnv["Bindings"],
  input: PiLineAgentRunRequest,
): Promise<PiLineAgentRunResponse> {
  return requestAgent<PiLineAgentRunResponse>(env, input, "/run", input);
}

export async function resetPiLineAgent(
  env: AppEnv["Bindings"],
  input: PiLineAgentContext,
): Promise<PiLineAgentResetResponse> {
  return requestAgent<PiLineAgentResetResponse>(env, input, "/reset", input);
}
