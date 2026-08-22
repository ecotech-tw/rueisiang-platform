import type { AssistantRunResult } from "@rueisiang/assistant";
import type { LineSourceType } from "./line-queue.js";

export interface PiLineAgentContext {
  assistantKey: string;
  channelKey: string;
  groupRowId: string;
  lineGroupId: string;
  sourceType: LineSourceType;
  /** D1 的 contextResetAt；舊工作若帶著較早的 generation，DO 會拒絕寫回新 session。 */
  contextGeneration: string;
}

export interface PiLineAgentRunRequest extends PiLineAgentContext {
  webhookEventId: string;
  runId: string;
  model: string;
  systemPrompt: string;
  userText: string;
  toolKeys: string[];
}

export interface PiLineAgentRunResponse {
  sessionId: string;
  model: string;
  result: AssistantRunResult;
}

export interface PiLineAgentResetRequest extends PiLineAgentContext {}

export interface PiLineAgentResetResponse {
  sessionId: string;
  reset: boolean;
}
