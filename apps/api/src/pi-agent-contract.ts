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
  /** 群組／多人聊天室的圖片只屬於目前這一輪，不寫入 DO transcript。 */
  quotedMessageId?: string;
}

export interface PiAgentAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
  checksum: string;
  expiresAt?: string | null;
}

export interface PiLineAgentRunRequest extends PiLineAgentContext {
  /** 用來從既有 D1 訊息回填 transcript 時排除這次已寫入的 webhook 事件。 */
  webhookEventId: string;
  runId: string;
  model: string;
  /** 主要模型回傳 error 時使用的備援模型；未設定時不切換。 */
  fallbackModel?: string | null;
  systemPrompt: string;
  userText: string;
  toolKeys: string[];
  attachments?: PiAgentAttachment[];
  /** false 時只把圖片送給目前這輪模型，不讓它出現在後續對話。 */
  persistAttachments?: boolean;
}

export interface PiLineAgentRunResponse {
  sessionId: string;
  model: string;
  result: AssistantRunResult;
}

export interface PiSandboxAgentContext {
  assistantKey: string;
  /** 有 D1 session 時就是 session id；單次 API 測試則使用 run id，避免不同測試互相污染。 */
  conversationId: string;
  sandboxSessionId: string | null;
  actorUserId: string;
  /** D1 session createdAt；同一個 session 固定不變，也能擋掉錯誤路由到舊 DO 的請求。 */
  contextGeneration: string;
}

export interface PiSandboxAgentRunRequest extends PiSandboxAgentContext {
  runId: string;
  model: string;
  /** 主要模型回傳 error 時使用的備援模型；未設定時不切換。 */
  fallbackModel?: string | null;
  systemPrompt: string;
  userText: string;
  toolKeys: string[];
  attachments?: PiAgentAttachment[];
}

export type PiSandboxAgentRunResponse = PiLineAgentRunResponse;

export type PiAgentRunRequest = PiLineAgentRunRequest | PiSandboxAgentRunRequest;
export type PiAgentRunResponse = PiLineAgentRunResponse | PiSandboxAgentRunResponse;

export interface PiLineAgentResetRequest extends PiLineAgentContext {}

export interface PiLineAgentResetResponse {
  sessionId: string;
  reset: boolean;
}
