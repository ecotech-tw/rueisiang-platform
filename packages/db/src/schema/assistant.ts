import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const isoNow = () => new Date().toISOString();

/** AI 助理 Sandbox 與後續 LINE channel 共用的設定與執行紀錄。 */
export const assistantConfigs = sqliteTable("assistant_configs", {
  assistantKey: text("assistant_key").primaryKey(),
  activeModel: text("active_model").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
});

export const assistantPromptRevisions = sqliteTable("assistant_prompt_revisions", {
  id: text("id").primaryKey(),
  assistantKey: text("assistant_key").notNull(),
  revision: integer("revision").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_assistant_prompt_key_revision").on(table.assistantKey, table.revision),
  index("idx_assistant_prompt_active").on(table.assistantKey, table.isActive),
]);

/** tool 的生命週期由資料庫控制，tool 的實際 schema 與 executor 則寫在程式碼。 */
export const assistantToolConfigs = sqliteTable("assistant_tool_configs", {
  key: text("key").primaryKey(),
  status: text("status").notNull().default("development"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
});

/**
 * 每次模型執行一筆，Sandbox 與未來 LINE 都走同一張表。
 * 不保存完整 prompt / response，避免把內部對話複製到用量資料表；只保存分析必要的摘要。
 */
export const assistantRuns = sqliteTable("assistant_runs", {
  id: text("id").primaryKey(),
  /** surface（sandbox / line），不是哪個 bot——那是 assistantKey 與 channelKey 的工作。 */
  channel: text("channel").notNull(),
  assistantKey: text("assistant_key"),
  channelKey: text("channel_key"),
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
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
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
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
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
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
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
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  index("idx_assistant_sandbox_messages_session_created_at").on(table.sessionId, table.createdAt),
]);

/** LINE 前台的 channel 設定；兩個 credential 都只在 D1 保存加密值。 */
export const assistantLineChannels = sqliteTable("assistant_line_channels", {
  /**
   * 這個 channel 自己的鍵值，也是所有 channel 相關紀錄的關聯對象。
   *
   * 不用 `assistantKey` 當主鍵：官網客服會是第二個 LINE 官方帳號，一個 assistant 之後
   * 可能掛多個 channel。用 `assistantKey` 的話，那一天所有指過來的外鍵都會失去指向性——
   * 兩個帳號的同名群組會撞在一起，或套到別的 channel 的工具政策。
   *
   * `channelId` 是 LINE 自己發的 Channel ID，跟這個是兩回事，不要混用。
   */
  channelKey: text("channel_key").primaryKey(),
  assistantKey: text("assistant_key").notNull(),
  channelId: text("channel_id").notNull().default(""),
  channelSecretEncrypted: text("channel_secret_encrypted").notNull().default(""),
  accessTokenEncrypted: text("access_token_encrypted").notNull().default(""),
  displayName: text("display_name").notNull().default("Rueisiang 小香"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedBy: text("updated_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  /**
   * 後台目前只管小香一個 assistant，所以先把「一個 assistant 一個 channel」寫死在這裡。
   * 開放官網客服當第二個 channel 時，移除這個索引就好，不必再動資料。
   */
  uniqueIndex("idx_assistant_line_channels_assistant").on(table.assistantKey),
]);

/** LINE 曾經發現過的對話。只有 enabled 的對話可以讓小香在線上回覆。 */
export const assistantLineGroups = sqliteTable("assistant_line_groups", {
  id: text("id").primaryKey(),
  channelKey: text("channel_key").notNull().references(() => assistantLineChannels.channelKey, { onDelete: "cascade" }),
  lineGroupId: text("line_group_id").notNull(),
  /** `group`、`room` 或 `user`；舊資料沒有這欄時以 group 相容。 */
  sourceType: text("source_type").notNull().default("group"),
  displayName: text("display_name").notNull().default(""),
  /**
   * 從 LINE 取回的大頭貼網址。
   *
   * **會過期**，所以只當快取用，不要當成永久網址存到別的地方；每次同步都重新取。
   * 沒有設定大頭貼的對話會是空字串。
   */
  pictureUrl: text("picture_url").notNull().default(""),
  /**
   * 名稱是不是人手動設定的。
   *
   * 需要分開記，不能靠「名字是不是空的」判斷：第一次同步之後 displayName 就有值了，
   * 再用空值當條件的話，LINE 那邊之後改名永遠跟不上；反過來若一律覆蓋，管理員把
   * 「專案討論」改成「倉庫群」的決定又會被洗掉。
   */
  displayNameManual: integer("display_name_manual", { mode: "boolean" }).notNull().default(false),
  /** 上次跟 LINE 同步名稱與大頭貼的時間。沒同步過是 null。 */
  profileSyncedAt: text("profile_synced_at"),
  /** 只切換模型上下文的起點，歷史訊息仍保留供稽核與監控使用。 */
  contextResetAt: text("context_reset_at"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /**
   * `inherit` 就是 channel 給的全部，`custom` 才去讀 `assistant_chat_tools`。
   *
   * 預設 `inherit` 是因為客服帳號的對話會自動長出來，不可能每一個手動設定；內部對話本來
   * 就有 `enabled` 那道閘擋著，真正的上限永遠在 channel 層。
   */
  toolMode: text("tool_mode").notNull().default("inherit"),
  discoveredAt: text("discovered_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_assistant_line_groups_key_group").on(table.channelKey, table.lineGroupId),
  index("idx_assistant_line_groups_enabled").on(table.channelKey, table.enabled),
]);

/** 群組／聊天室只收標註小香的文字；一對一訊息也會進來，供後續 LINE 對話組裝 context。 */
export const assistantLineMessages = sqliteTable("assistant_line_messages", {
  id: text("id").primaryKey(),
  channelKey: text("channel_key").notNull(),
  lineGroupId: text("line_group_id").notNull(),
  sourceType: text("source_type").notNull(),
  webhookEventId: text("webhook_event_id").notNull(),
  lineMessageId: text("line_message_id"),
  lineUserId: text("line_user_id"),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_assistant_line_messages_event").on(table.channelKey, table.webhookEventId),
  index("idx_assistant_line_messages_group_created_at").on(table.channelKey, table.lineGroupId, table.createdAt),
]);

/**
 * LINE reply token 過期前若只能先送忙碌提示，模型完成後的內容放在這裡。
 * groupId 是資料庫內的 chat relation；lineGroupId 保留 LINE 外部 ID 供稽核與查詢。
 */
export const assistantLineReplyBackups = sqliteTable("assistant_line_reply_backups", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  channelKey: text("channel_key").notNull(),
  groupId: text("group_id").notNull().references(() => assistantLineGroups.id, { onDelete: "cascade" }),
  lineGroupId: text("line_group_id").notNull(),
  sourceType: text("source_type").notNull(),
  webhookEventId: text("webhook_event_id").notNull(),
  questionText: text("question_text").notNull(),
  responseText: text("response_text").notNull().default(""),
  model: text("model").notNull().default(""),
  status: text("status").notNull().default("ready"),
  reason: text("reason").notNull().default("reply_token_deadline"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_assistant_line_reply_backups_run").on(table.runId),
  index("idx_assistant_line_reply_backups_group_created_at").on(table.groupId, table.createdAt),
  index("idx_assistant_line_reply_backups_external_chat_created_at").on(table.channelKey, table.lineGroupId, table.createdAt),
]);

/**
 * Push API 的 fixed-window ledger。每次 Push 嘗試都留一列，才能同時做到 run 去重、額度稽核與失敗保守預約。
 * windowKey 使用 LINE 計費時區（GMT+9）的 `YYYY-MM`；`reserved`、`sent`、`failed` 都會占用本地額度。
 */
export const assistantLinePushDeliveries = sqliteTable("assistant_line_push_deliveries", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  channelKey: text("channel_key").notNull(),
  groupId: text("group_id").notNull().references(() => assistantLineGroups.id, { onDelete: "cascade" }),
  lineGroupId: text("line_group_id").notNull(),
  sourceType: text("source_type").notNull(),
  windowKey: text("window_key").notNull(),
  recipientCount: integer("recipient_count").notNull(),
  remoteUsage: integer("remote_usage").notNull(),
  /** 預約後的本地用量高水位；用來吸收 LINE usage API 的回報延遲。 */
  reservedThrough: integer("reserved_through").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_assistant_line_push_deliveries_run").on(table.runId),
  index("idx_assistant_line_push_deliveries_window_status").on(table.channelKey, table.windowKey, table.status),
  index("idx_assistant_line_push_deliveries_group_created_at").on(table.groupId, table.createdAt),
]);

/**
 * 這個 channel 能用哪些工具。**這是 LINE 這條路真正的授權來源。**
 *
 * 工具契約上的 `requiredPermissions` 在 LINE 用不上——那條路沒有平台使用者可以查權限，
 * 對面是一個 LINE 對話。與其讓它宣告在那裡卻沒人讀，不如明講：LINE 看 channel 白名單。
 *
 * 沒有列 = 不給。忘記設定的後果是「不能用」，不是「全都能用」。
 */
export const assistantChannelTools = sqliteTable("assistant_channel_tools", {
  id: text("id").primaryKey(),
  channelKey: text("channel_key").notNull().references(() => assistantLineChannels.channelKey, { onDelete: "cascade" }),
  toolKey: text("tool_key").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_assistant_channel_tools_channel_tool").on(table.channelKey, table.toolKey),
]);

/**
 * 某個對話能用哪些工具。只有 `toolMode = "custom"` 的對話會讀這張表。
 *
 * **外鍵指向 `assistant_channel_tools` 那一列，不是直接指向工具鍵值。** 這讓「對話拿到的
 * 權限不可能超過 channel」變成資料庫層級的保證：channel 收回一個工具時 CASCADE 會把底下
 * 所有對話的授權一起帶走，不可能留下孤兒。指向工具鍵值的話，這件事就要靠每一段程式自己
 * 記得檢查——程式會忘記，外鍵不會。
 */
export const assistantChatTools = sqliteTable("assistant_chat_tools", {
  id: text("id").primaryKey(),
  groupId: text("group_id").notNull().references(() => assistantLineGroups.id, { onDelete: "cascade" }),
  channelToolId: text("channel_tool_id").notNull().references(() => assistantChannelTools.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
}, (table) => [
  uniqueIndex("idx_assistant_chat_tools_group_tool").on(table.groupId, table.channelToolId),
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
export type AssistantLineReplyBackup = typeof assistantLineReplyBackups.$inferSelect;
export type AssistantLinePushDelivery = typeof assistantLinePushDeliveries.$inferSelect;
export type AssistantChannelTool = typeof assistantChannelTools.$inferSelect;
export type AssistantChatTool = typeof assistantChatTools.$inferSelect;
