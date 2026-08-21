export type AssistantToolStatus = "enabled" | "development" | "disabled";

export interface JsonSchema {
  type: "OBJECT";
  properties: Record<string, { type: "STRING"; description: string }>;
  required?: string[];
}

export interface AssistantToolDefinition {
  key: string;
  label: string;
  description: string;
  defaultStatus: AssistantToolStatus;
  parameters: JsonSchema;
  execute(input: unknown): Promise<string>;
}

export interface AssistantToolCall {
  toolKey: string;
  status: "success" | "failed";
  durationMs: number;
  errorMessage?: string;
}

export interface AssistantUsage {
  promptTokens: number;
  candidateTokens: number;
  totalTokens: number;
}

export interface AssistantConversationMessage {
  role: "user" | "model";
  text: string;
}

export interface AssistantRunResult {
  text: string;
  thoughts: string;
  toolCalls: AssistantToolCall[];
  usage: AssistantUsage;
}

export class AssistantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssistantError";
  }
}
