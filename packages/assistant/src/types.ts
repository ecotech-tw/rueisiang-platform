export type AssistantToolStatus = "enabled" | "development" | "disabled";

export type AssistantToolSurface = "sandbox" | "line" | "mcp";

export interface AssistantToolContext {
  surface: AssistantToolSurface;
  /** Runtime services are injected by the host application, not the model. */
  db?: unknown;
  env?: unknown;
  user?: unknown;
  services?: Record<string, unknown>;
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  enum?: string[];
}

/** Model-neutral JSON Schema. Provider adapters translate this when needed. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface AssistantToolDefinition {
  key: string;
  label: string;
  description: string;
  defaultStatus: AssistantToolStatus;
  parameters: JsonSchema;
  execute(input: unknown, context?: AssistantToolContext): Promise<string>;
}

export interface AssistantToolCall {
  toolKey: string;
  status: "success" | "failed";
  durationMs: number;
  /** Sandbox debug 用；不會寫入用量統計表或 Worker structured log。 */
  args?: Record<string, unknown>;
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
  toolCalls: AssistantToolCall[] = [];

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AssistantError";
  }
}
