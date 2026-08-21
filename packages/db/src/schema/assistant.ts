import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** AI 助理 Sandbox 與後續 LINE channel 共用的設定與執行紀錄。 */
export const assistantConfigs = sqliteTable("assistant_configs", {
  assistantKey: text("assistant_key").primaryKey(),
  activeModel: text("active_model").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

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
  sessionId: text("session_id"),
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
  index("idx_assistant_runs_session_created_at").on(table.sessionId, table.createdAt),
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

/** Sandbox 對話的生命週期；關閉後不可再追加訊息，重新測試要建立新 session。 */
export const assistantSandboxSessions = sqliteTable("assistant_sandbox_sessions", {
  id: text("id").primaryKey(),
  assistantKey: text("assistant_key").notNull(),
  createdBy: text("created_by").notNull(),
  model: text("model").notNull(),
  promptRevisionId: text("prompt_revision_id").notNull(),
  status: text("status").notNull().default("open"),
  contextSummary: text("context_summary").notNull().default(""),
  contextSummaryMessageCount: integer("context_summary_message_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  closedAt: text("closed_at"),
}, (table) => [
  index("idx_assistant_sandbox_sessions_owner_updated_at").on(table.assistantKey, table.createdBy, table.updatedAt),
  index("idx_assistant_sandbox_sessions_status").on(table.assistantKey, table.createdBy, table.status),
]);

export const assistantSandboxMessages = sqliteTable("assistant_sandbox_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => assistantSandboxSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  text: text("text").notNull(),
  model: text("model").notNull().default(""),
  thoughts: text("thoughts").notNull().default(""),
  toolCalls: text("tool_calls").notNull().default("[]"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_assistant_sandbox_messages_session_created_at").on(table.sessionId, table.createdAt),
]);

/** LINE 前台的 channel 設定；兩個 credential 都只在 D1 保存加密值。 */
export const assistantLineChannels = sqliteTable("assistant_line_channels", {
  assistantKey: text("assistant_key").primaryKey(),
  channelId: text("channel_id").notNull().default(""),
  channelSecretEncrypted: text("channel_secret_encrypted").notNull().default(""),
  accessTokenEncrypted: text("access_token_encrypted").notNull().default(""),
  displayName: text("display_name").notNull().default("Rueisiang 小香"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedBy: text("updated_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** LINE 曾經發現過的群組。只有 enabled 的群組可以讓小香在線上回覆。 */
export const assistantLineGroups = sqliteTable("assistant_line_groups", {
  id: text("id").primaryKey(),
  assistantKey: text("assistant_key").notNull().references(() => assistantLineChannels.assistantKey, { onDelete: "cascade" }),
  lineGroupId: text("line_group_id").notNull(),
  displayName: text("display_name").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  discoveredAt: text("discovered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_assistant_line_groups_key_group").on(table.assistantKey, table.lineGroupId),
  index("idx_assistant_line_groups_enabled").on(table.assistantKey, table.enabled),
]);

/** 只有標註小香的文字訊息會進來，供後續 LINE 對話組裝 context。 */
export const assistantLineMessages = sqliteTable("assistant_line_messages", {
  id: text("id").primaryKey(),
  assistantKey: text("assistant_key").notNull(),
  lineGroupId: text("line_group_id").notNull(),
  sourceType: text("source_type").notNull(),
  webhookEventId: text("webhook_event_id").notNull(),
  lineMessageId: text("line_message_id"),
  lineUserId: text("line_user_id"),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_assistant_line_messages_event").on(table.assistantKey, table.webhookEventId),
  index("idx_assistant_line_messages_group_created_at").on(table.assistantKey, table.lineGroupId, table.createdAt),
]);

export type AssistantPromptRevision = typeof assistantPromptRevisions.$inferSelect;
export type AssistantConfig = typeof assistantConfigs.$inferSelect;
export type AssistantToolConfig = typeof assistantToolConfigs.$inferSelect;
export type AssistantRun = typeof assistantRuns.$inferSelect;
export type AssistantToolCall = typeof assistantToolCalls.$inferSelect;
export type AssistantSandboxSession = typeof assistantSandboxSessions.$inferSelect;
export type AssistantSandboxMessage = typeof assistantSandboxMessages.$inferSelect;
export type AssistantLineChannel = typeof assistantLineChannels.$inferSelect;
export type AssistantLineGroup = typeof assistantLineGroups.$inferSelect;
export type AssistantLineMessage = typeof assistantLineMessages.$inferSelect;
