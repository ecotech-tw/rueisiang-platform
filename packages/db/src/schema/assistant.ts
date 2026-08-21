import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** AI 助理 Sandbox 與後續 LINE channel 共用的設定與執行紀錄。 */
export const assistantPromptRevisions = sqliteTable("assistant_prompt_revisions", {
  id: text("id").primaryKey(),
  assistantKey: text("assistant_key").notNull(),
  revision: integer("revision").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_assistant_prompt_key_revision").on(table.assistantKey, table.revision),
  index("idx_assistant_prompt_active").on(table.assistantKey, table.isActive),
]);

/** tool 的生命週期由資料庫控制，tool 的實際 schema 與 executor 則寫在程式碼。 */
export const assistantToolConfigs = sqliteTable("assistant_tool_configs", {
  key: text("key").primaryKey(),
  status: text("status").notNull().default("development"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * 每次模型執行一筆，Sandbox 與未來 LINE 都走同一張表。
 * 不保存完整 prompt / response，避免把內部對話複製到用量資料表；只保存分析必要的摘要。
 */
export const assistantRuns = sqliteTable("assistant_runs", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  groupId: text("group_id"),
  model: text("model").notNull(),
  promptRevisionId: text("prompt_revision_id").notNull(),
  inputChars: integer("input_chars").notNull(),
  outputChars: integer("output_chars").notNull().default(0),
  promptTokens: integer("prompt_tokens"),
  candidateTokens: integer("candidate_tokens"),
  totalTokens: integer("total_tokens"),
  status: text("status").notNull(),
  durationMs: integer("duration_ms").notNull(),
  actorId: text("actor_id"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_assistant_runs_channel_created_at").on(table.channel, table.createdAt),
  index("idx_assistant_runs_group_created_at").on(table.groupId, table.createdAt),
]);

export const assistantToolCalls = sqliteTable("assistant_tool_calls", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  toolKey: text("tool_key").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms").notNull(),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_assistant_tool_calls_run_id").on(table.runId),
  index("idx_assistant_tool_calls_tool_created_at").on(table.toolKey, table.createdAt),
]);

export type AssistantPromptRevision = typeof assistantPromptRevisions.$inferSelect;
export type AssistantToolConfig = typeof assistantToolConfigs.$inferSelect;
export type AssistantRun = typeof assistantRuns.$inferSelect;
export type AssistantToolCall = typeof assistantToolCalls.$inferSelect;
