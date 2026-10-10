export type ToolStatus = "enabled" | "development" | "disabled";
export type ToolSurface = "sandbox" | "line" | "mcp";

export interface ToolContext {
  surface: ToolSurface;
  lineSourceType?: "user" | "group" | "room";
  db?: unknown;
  env?: unknown;
  user?: unknown;
  services?: Record<string, unknown>;
}

export interface ToolJsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  enum?: string[];
}

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, ToolJsonSchemaProperty>;
  required?: string[];
}

/**
 * Provider-neutral tool contract.
 *
 * Gemini, GPT and future MCP hosts adapt only the declaration and message
 * transport. The executor and its permissions stay the same.
 */
export interface ToolContract {
  key: string;
  label: string;
  description: string;
  defaultStatus: ToolStatus;
  parameters: ToolJsonSchema;
  surfaces: readonly ToolSurface[];
  lineSourceTypes?: readonly ("user" | "group" | "room")[];
  requiredPermissions?: readonly string[];
  execute(input: unknown, context?: ToolContext): Promise<string>;
}
