import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  AssistantToolCall as RecordedToolCall,
  AssistantToolStatus,
  AssistantUsage,
} from "@rueisiang/assistant";
import type { Database } from "./client.js";
import {
  assistantPromptRevisions,
  assistantConfigs,
  assistantRuns,
  assistantToolCalls,
  assistantToolConfigs,
  assistantChannelTools,
  assistantChatTools,
  assistantLineChannels,
  assistantLineGroups,
  assistantLineMessages,
  assistantSandboxMessages,
  assistantSandboxSessions,
  type AssistantChannelTool,
  type AssistantConfig,
  type AssistantLineChannel,
  type AssistantLineGroup,
  type AssistantLineMessage,
  type AssistantPromptRevision,
  type AssistantSandboxMessage,
  type AssistantSandboxSession,
  type AssistantToolConfig,
} from "./schema/assistant.js";

export type AssistantChannel = "sandbox" | "line";
export type AssistantRunStatus = "success" | "failed";
export type AssistantSandboxSessionStatus = "open" | "closed";
export type AssistantSandboxMessageRole = "user" | "model";
export const DEFAULT_ASSISTANT_LINE_DISPLAY_NAME = "Rueisiang 小香";

/**
 * 取得（必要時建立）某個 assistant 的 LINE channel。
 *
 * 現階段一個 assistant 只有一個 channel，所以新建時 `channelKey` 直接沿用 `assistantKey`。
 * 值相同不代表概念相同——關聯一律走 `channelKey`，官網客服當第二個 channel 進來時，
 * 這裡改成產新的鍵值即可，既有資料不必再搬。
 */
export async function ensureAssistantLineChannel(
  db: Database,
  input: { assistantKey: string; updatedBy?: string },
): Promise<AssistantLineChannel> {
  const [existing] = await db
    .select()
    .from(assistantLineChannels)
    .where(eq(assistantLineChannels.assistantKey, input.assistantKey))
    .limit(1);
  if (existing) return existing;

  const now = new Date().toISOString();
  await db.insert(assistantLineChannels).values({
    channelKey: input.assistantKey,
    assistantKey: input.assistantKey,
    channelId: "",
    channelSecretEncrypted: "",
    accessTokenEncrypted: "",
    displayName: DEFAULT_ASSISTANT_LINE_DISPLAY_NAME,
    enabled: false,
    updatedBy: input.updatedBy ?? "system",
    updatedAt: now,
  }).onConflictDoNothing();
  const [created] = await db
    .select()
    .from(assistantLineChannels)
    .where(eq(assistantLineChannels.assistantKey, input.assistantKey))
    .limit(1);
  if (!created) throw new Error("建立 LINE channel 設定後找不到資料。");
  return created;
}

export async function getAssistantLineChannel(db: Database, assistantKey: string): Promise<AssistantLineChannel | null> {
  const [row] = await db
    .select()
    .from(assistantLineChannels)
    .where(eq(assistantLineChannels.assistantKey, assistantKey))
    .limit(1);
  return row ?? null;
}

export async function updateAssistantLineChannel(
  db: Database,
  input: {
    channelKey: string;
    assistantKey: string;
    channelId: string;
    channelSecretEncrypted?: string;
    accessTokenEncrypted?: string;
    displayName: string;
    enabled: boolean;
    updatedBy: string;
  },
): Promise<AssistantLineChannel> {
  const values: {
    channelId: string;
    displayName: string;
    enabled: boolean;
    updatedBy: string;
    updatedAt: string;
    channelSecretEncrypted?: string;
    accessTokenEncrypted?: string;
  } = {
    channelId: input.channelId,
    displayName: input.displayName,
    enabled: input.enabled,
    updatedBy: input.updatedBy,
    updatedAt: new Date().toISOString(),
  };
  if (input.channelSecretEncrypted !== undefined) values.channelSecretEncrypted = input.channelSecretEncrypted;
  if (input.accessTokenEncrypted !== undefined) values.accessTokenEncrypted = input.accessTokenEncrypted;
  await db
    .update(assistantLineChannels)
    .set(values)
    .where(eq(assistantLineChannels.channelKey, input.channelKey));
  const channel = await getAssistantLineChannel(db, input.assistantKey);
  if (!channel) throw new Error("更新 LINE channel 設定後找不到資料。");
  return channel;
}

export async function listAssistantLineGroups(db: Database, channelKey: string): Promise<AssistantLineGroup[]> {
  return db
    .select()
    .from(assistantLineGroups)
    .where(eq(assistantLineGroups.channelKey, channelKey))
    .orderBy(
      sql`CASE WHEN instr(${assistantLineGroups.discoveredAt}, 'T') > 0 THEN ${assistantLineGroups.discoveredAt} ELSE replace(${assistantLineGroups.discoveredAt}, ' ', 'T') || '.000Z' END DESC`,
      desc(assistantLineGroups.id),
    );
}

export async function findAssistantLineGroup(db: Database, input: { channelKey: string; id: string }): Promise<AssistantLineGroup | null> {
  const [row] = await db
    .select()
    .from(assistantLineGroups)
    .where(and(eq(assistantLineGroups.channelKey, input.channelKey), eq(assistantLineGroups.id, input.id)))
    .limit(1);
  return row ?? null;
}

export async function upsertAssistantLineGroup(
  db: Database,
  input: { channelKey: string; lineGroupId: string; displayName?: string },
): Promise<AssistantLineGroup> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(assistantLineGroups).values({
    id,
    channelKey: input.channelKey,
    lineGroupId: input.lineGroupId,
    displayName: input.displayName ?? "",
    discoveredAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const [created] = await db
    .select()
    .from(assistantLineGroups)
    .where(and(
      eq(assistantLineGroups.channelKey, input.channelKey),
      eq(assistantLineGroups.lineGroupId, input.lineGroupId),
    ))
    .limit(1);
  if (!created) throw new Error("建立 LINE 群組後找不到資料。");
  if (input.displayName && input.displayName !== created.displayName) {
    await db.update(assistantLineGroups)
      .set({ displayName: input.displayName, updatedAt: new Date().toISOString() })
      .where(eq(assistantLineGroups.id, created.id));
    return (await findAssistantLineGroup(db, { channelKey: input.channelKey, id: created.id })) ?? created;
  }
  return created;
}

export async function updateAssistantLineGroup(
  db: Database,
  /** `displayNameManual` 只有在使用者真的送了名稱時才給 true——切開關不算命名。 */
  input: { channelKey: string; id: string; displayName: string; enabled: boolean; displayNameManual?: boolean },
): Promise<AssistantLineGroup | null> {
  await db.update(assistantLineGroups)
    .set({
      displayName: input.displayName,
      enabled: input.enabled,
      ...(input.displayNameManual ? { displayNameManual: true } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(assistantLineGroups.channelKey, input.channelKey), eq(assistantLineGroups.id, input.id)));
  return findAssistantLineGroup(db, { channelKey: input.channelKey, id: input.id });
}

/**
 * 從 LINE 取回的名稱與大頭貼寫回群組。
 *
 * 名稱只在「不是人手動設定的」時候覆蓋，看的是 displayNameManual 而不是「名字是不是
 * 空的」：第一次同步之後名字就有值了，再用空值當條件的話，LINE 那邊之後改名永遠跟不上。
 * 管理員改過的名字比 LINE 的原名更有意義（例如把「專案討論」改成「倉庫群」），那個決定
 * 要留著。大頭貼沒有這個問題，一律以 LINE 為準。
 */
export async function updateAssistantLineGroupProfile(
  db: Database,
  input: { channelKey: string; id: string; groupName: string; pictureUrl: string },
): Promise<void> {
  const now = new Date().toISOString();
  await db.update(assistantLineGroups)
    .set({
      displayName: sql`CASE WHEN ${assistantLineGroups.displayNameManual} = 0 AND ${input.groupName} != '' THEN ${input.groupName} ELSE ${assistantLineGroups.displayName} END`,
      pictureUrl: input.pictureUrl,
      profileSyncedAt: now,
      updatedAt: now,
    })
    .where(and(eq(assistantLineGroups.channelKey, input.channelKey), eq(assistantLineGroups.id, input.id)));
}

/**
 * 這個群組現在該不該去跟 LINE 要一次名稱與大頭貼。
 *
 * 不是每則訊息都打：群組改名很少見，而大頭貼網址雖然會過期，重抓一次也只是為了顯示。
 * 每則訊息都打一次只是在燒 LINE 的速率限制，換不到任何東西。
 *
 * 還沒有名字的（剛被發現、或被 0028 救回來的）例外，那種要立刻補上——只有一串 ID
 * 的群組在後台根本認不出是哪一個。
 */
export function shouldSyncLineGroupProfile(
  group: { displayName: string; profileSyncedAt: string | null },
  now = Date.now(),
  maxAgeMs = 6 * 60 * 60 * 1_000,
): boolean {
  if (!group.displayName) return true;
  if (!group.profileSyncedAt) return true;
  const synced = new Date(group.profileSyncedAt).getTime();
  return !Number.isFinite(synced) || now - synced > maxAgeMs;
}

export async function recordAssistantLineMessage(
  db: Database,
  input: {
    channelKey: string;
    lineGroupId: string;
    sourceType: string;
    webhookEventId: string;
    lineMessageId?: string;
    lineUserId?: string;
    text: string;
  },
): Promise<{ message: AssistantLineMessage; inserted: boolean }> {
  const id = crypto.randomUUID();
  await db.insert(assistantLineMessages).values({ id, ...input, createdAt: new Date().toISOString() }).onConflictDoNothing();
  const [created] = await db.select().from(assistantLineMessages).where(and(
    eq(assistantLineMessages.channelKey, input.channelKey),
    eq(assistantLineMessages.webhookEventId, input.webhookEventId),
  )).limit(1);
  if (!created) throw new Error("記錄 LINE 訊息後找不到資料。");
  return { message: created, inserted: created.id === id };
}

export async function listAssistantLineMessages(
  db: Database,
  input: { channelKey: string; lineGroupId: string; limit?: number },
): Promise<AssistantLineMessage[]> {
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
  const rows = await db
    .select()
    .from(assistantLineMessages)
    .where(and(
      eq(assistantLineMessages.channelKey, input.channelKey),
      eq(assistantLineMessages.lineGroupId, input.lineGroupId),
    ))
    .orderBy(
      sql`CASE WHEN instr(${assistantLineMessages.createdAt}, 'T') > 0 THEN ${assistantLineMessages.createdAt} ELSE replace(${assistantLineMessages.createdAt}, ' ', 'T') || '.000Z' END DESC`,
      desc(assistantLineMessages.id),
    )
    .limit(limit);
  return rows.reverse();
}

export async function createAssistantSandboxSession(
  db: Database,
  input: { assistantKey: string; createdBy: string; model: string; promptRevisionId: string },
): Promise<AssistantSandboxSession> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(assistantSandboxSessions).values({
    id,
    assistantKey: input.assistantKey,
    createdBy: input.createdBy,
    model: input.model,
    promptRevisionId: input.promptRevisionId,
    status: "open",
    createdAt: now,
    updatedAt: now,
  });
  const session = await getAssistantSandboxSession(db, { assistantKey: input.assistantKey, createdBy: input.createdBy, id });
  if (!session) throw new Error("建立 Sandbox session 後找不到資料。");
  return session;
}

export async function listAssistantSandboxSessions(
  db: Database,
  input: { assistantKey: string; createdBy: string; limit?: number },
): Promise<AssistantSandboxSession[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  return db
    .select()
    .from(assistantSandboxSessions)
    .where(and(
      eq(assistantSandboxSessions.assistantKey, input.assistantKey),
      eq(assistantSandboxSessions.createdBy, input.createdBy),
    ))
    .orderBy(
      sql`CASE WHEN instr(${assistantSandboxSessions.updatedAt}, 'T') > 0 THEN ${assistantSandboxSessions.updatedAt} ELSE replace(${assistantSandboxSessions.updatedAt}, ' ', 'T') || '.000Z' END DESC`,
      desc(assistantSandboxSessions.id),
    )
    .limit(limit);
}

export async function getAssistantSandboxSession(
  db: Database,
  input: { assistantKey: string; createdBy: string; id: string },
): Promise<AssistantSandboxSession | null> {
  const [session] = await db
    .select()
    .from(assistantSandboxSessions)
    .where(and(
      eq(assistantSandboxSessions.assistantKey, input.assistantKey),
      eq(assistantSandboxSessions.createdBy, input.createdBy),
      eq(assistantSandboxSessions.id, input.id),
    ))
    .limit(1);
  return session ?? null;
}

export async function updateAssistantSandboxSessionModel(
  db: Database,
  input: { assistantKey: string; createdBy: string; id: string; model: string },
): Promise<AssistantSandboxSession | null> {
  await db.update(assistantSandboxSessions)
    .set({ model: input.model, updatedAt: new Date().toISOString() })
    .where(and(
      eq(assistantSandboxSessions.assistantKey, input.assistantKey),
      eq(assistantSandboxSessions.createdBy, input.createdBy),
      eq(assistantSandboxSessions.id, input.id),
    ));
  return getAssistantSandboxSession(db, input);
}

export async function updateAssistantSandboxSessionPromptRevision(
  db: Database,
  input: { assistantKey: string; createdBy: string; id: string; promptRevisionId: string },
): Promise<AssistantSandboxSession | null> {
  await db.update(assistantSandboxSessions)
    .set({ promptRevisionId: input.promptRevisionId, updatedAt: new Date().toISOString() })
    .where(and(
      eq(assistantSandboxSessions.assistantKey, input.assistantKey),
      eq(assistantSandboxSessions.createdBy, input.createdBy),
      eq(assistantSandboxSessions.id, input.id),
    ));
  return getAssistantSandboxSession(db, input);
}

export async function updateAssistantSandboxContext(
  db: Database,
  input: {
    assistantKey: string;
    createdBy: string;
    id: string;
    contextSummary: string;
    contextSummaryMessageCount: number;
  },
): Promise<AssistantSandboxSession | null> {
  await db.update(assistantSandboxSessions)
    .set({
      contextSummary: input.contextSummary,
      contextSummaryMessageCount: input.contextSummaryMessageCount,
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(assistantSandboxSessions.assistantKey, input.assistantKey),
      eq(assistantSandboxSessions.createdBy, input.createdBy),
      eq(assistantSandboxSessions.id, input.id),
    ));
  return getAssistantSandboxSession(db, input);
}

export async function closeAssistantSandboxSession(
  db: Database,
  input: { assistantKey: string; createdBy: string; id: string },
): Promise<AssistantSandboxSession | null> {
  await db.update(assistantSandboxSessions)
    .set({ status: "closed", closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(and(
      eq(assistantSandboxSessions.assistantKey, input.assistantKey),
      eq(assistantSandboxSessions.createdBy, input.createdBy),
      eq(assistantSandboxSessions.id, input.id),
    ));
  return getAssistantSandboxSession(db, input);
}

export async function listAssistantSandboxMessages(
  db: Database,
  sessionId: string,
  limit = 100,
): Promise<AssistantSandboxMessage[]> {
  return db
    .select()
    .from(assistantSandboxMessages)
    .where(eq(assistantSandboxMessages.sessionId, sessionId))
    .orderBy(
      sql`CASE WHEN instr(${assistantSandboxMessages.createdAt}, 'T') > 0 THEN ${assistantSandboxMessages.createdAt} ELSE replace(${assistantSandboxMessages.createdAt}, ' ', 'T') || '.000Z' END DESC`,
      desc(assistantSandboxMessages.id),
    )
    .limit(Math.min(Math.max(limit, 1), 200))
    .then((rows) => rows.reverse());
}

/** Sandbox 執行需要完整序列，才能讓 contextSummaryMessageCount 對應到絕對位置。 */
export async function listAllAssistantSandboxMessages(
  db: Database,
  sessionId: string,
): Promise<AssistantSandboxMessage[]> {
  return db
    .select()
    .from(assistantSandboxMessages)
    .where(eq(assistantSandboxMessages.sessionId, sessionId))
    .orderBy(
      sql`CASE WHEN instr(${assistantSandboxMessages.createdAt}, 'T') > 0 THEN ${assistantSandboxMessages.createdAt} ELSE replace(${assistantSandboxMessages.createdAt}, ' ', 'T') || '.000Z' END ASC`,
      asc(assistantSandboxMessages.id),
    );
}

export async function appendAssistantSandboxMessage(
  db: Database,
  input: {
    sessionId: string;
    role: AssistantSandboxMessageRole;
    text: string;
    model?: string;
    thoughts?: string;
    toolCalls?: RecordedToolCall[];
    durationMs?: number;
  },
): Promise<AssistantSandboxMessage> {
  const id = crypto.randomUUID();
  const [latest] = await db
    .select({ createdAt: assistantSandboxMessages.createdAt })
    .from(assistantSandboxMessages)
    .where(eq(assistantSandboxMessages.sessionId, input.sessionId))
    .orderBy(
      sql`CASE WHEN instr(${assistantSandboxMessages.createdAt}, 'T') > 0 THEN ${assistantSandboxMessages.createdAt} ELSE replace(${assistantSandboxMessages.createdAt}, ' ', 'T') || '.000Z' END DESC`,
      desc(assistantSandboxMessages.id),
    )
    .limit(1);
  const latestTime = latest?.createdAt
    ? Date.parse(latest.createdAt.includes("T") ? latest.createdAt : `${latest.createdAt.replace(" ", "T")}Z`)
    : Number.NaN;
  const createdAt = new Date(Math.max(Date.now(), Number.isNaN(latestTime) ? 0 : latestTime + 1)).toISOString();
  await db.batch([
    db.insert(assistantSandboxMessages).values({
      id,
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      model: input.model ?? "",
      thoughts: input.thoughts ?? "",
      toolCalls: JSON.stringify(input.toolCalls ?? []),
      durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
      createdAt,
    }),
    db.update(assistantSandboxSessions).set({ updatedAt: new Date().toISOString() }).where(eq(assistantSandboxSessions.id, input.sessionId)),
  ]);
  const [message] = await db.select().from(assistantSandboxMessages).where(eq(assistantSandboxMessages.id, id)).limit(1);
  if (!message) throw new Error("保存 Sandbox 對話訊息後找不到資料。");
  return message;
}

export async function ensureAssistantDefaults(
  db: Database,
  input: { assistantKey: string; defaultModel: string; defaultPrompt: string; toolKeys: string[] },
): Promise<void> {
  const now = new Date().toISOString();
  const [config] = await db
    .select({ assistantKey: assistantConfigs.assistantKey })
    .from(assistantConfigs)
    .where(eq(assistantConfigs.assistantKey, input.assistantKey))
    .limit(1);
  if (!config) {
    await db.insert(assistantConfigs).values({
      assistantKey: input.assistantKey,
      activeModel: input.defaultModel,
      updatedBy: "system",
      updatedAt: now,
    }).onConflictDoNothing();
  }

  const [prompt] = await db
    .select({ id: assistantPromptRevisions.id })
    .from(assistantPromptRevisions)
    .where(eq(assistantPromptRevisions.assistantKey, input.assistantKey))
    .limit(1);
  if (!prompt) {
    await db.insert(assistantPromptRevisions).values({
      id: crypto.randomUUID(),
      assistantKey: input.assistantKey,
      revision: 1,
      systemPrompt: input.defaultPrompt,
      isActive: true,
      createdBy: "system",
      createdAt: now,
    }).onConflictDoNothing();
  }

  const existingTools = await db.select({ key: assistantToolConfigs.key }).from(assistantToolConfigs);
  const existing = new Set(existingTools.map((tool) => tool.key));
  for (const key of input.toolKeys) {
    if (existing.has(key)) continue;
    await db.insert(assistantToolConfigs).values({ key, status: "development", updatedBy: "system", updatedAt: now }).onConflictDoNothing();
  }
}

export async function getAssistantConfig(db: Database, assistantKey: string): Promise<AssistantConfig | null> {
  const [row] = await db.select().from(assistantConfigs).where(eq(assistantConfigs.assistantKey, assistantKey)).limit(1);
  return row ?? null;
}

export async function setActiveAssistantModel(
  db: Database,
  input: { assistantKey: string; activeModel: string; updatedBy: string },
): Promise<AssistantConfig> {
  await db
    .update(assistantConfigs)
    .set({ activeModel: input.activeModel, updatedBy: input.updatedBy, updatedAt: new Date().toISOString() })
    .where(eq(assistantConfigs.assistantKey, input.assistantKey));
  const config = await getAssistantConfig(db, input.assistantKey);
  if (!config) throw new Error("更新小香模型後找不到設定。");
  return config;
}

export async function setAssistantToolStatus(
  db: Database,
  input: { key: string; status: AssistantToolStatus; updatedBy: string },
): Promise<AssistantToolConfig> {
  await db
    .update(assistantToolConfigs)
    .set({ status: input.status, updatedBy: input.updatedBy, updatedAt: new Date().toISOString() })
    .where(eq(assistantToolConfigs.key, input.key));
  const [config] = await db.select().from(assistantToolConfigs).where(eq(assistantToolConfigs.key, input.key)).limit(1);
  if (!config) throw new Error("更新 tool 狀態後找不到設定。");
  return config;
}

export async function listAssistantPromptRevisions(db: Database, assistantKey: string): Promise<AssistantPromptRevision[]> {
  return db
    .select()
    .from(assistantPromptRevisions)
    .where(eq(assistantPromptRevisions.assistantKey, assistantKey))
    .orderBy(desc(assistantPromptRevisions.revision));
}

export async function findAssistantPromptRevision(db: Database, id: string): Promise<AssistantPromptRevision | null> {
  const [row] = await db.select().from(assistantPromptRevisions).where(eq(assistantPromptRevisions.id, id)).limit(1);
  return row ?? null;
}

export async function getActiveAssistantPrompt(db: Database, assistantKey: string): Promise<AssistantPromptRevision | null> {
  const [row] = await db
    .select()
    .from(assistantPromptRevisions)
    .where(and(
      eq(assistantPromptRevisions.assistantKey, assistantKey),
      eq(assistantPromptRevisions.isActive, true),
    ))
    .orderBy(desc(assistantPromptRevisions.revision))
    .limit(1);
  return row ?? null;
}

export async function listAssistantToolConfigs(db: Database): Promise<AssistantToolConfig[]> {
  return db.select().from(assistantToolConfigs).orderBy(assistantToolConfigs.key);
}

export async function createAssistantPromptRevision(
  db: Database,
  input: { assistantKey: string; systemPrompt: string; createdBy: string },
): Promise<AssistantPromptRevision> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const revisions = await listAssistantPromptRevisions(db, input.assistantKey);
    const revision = (revisions[0]?.revision ?? 0) + 1;
    const id = crypto.randomUUID();
    await db.insert(assistantPromptRevisions).values({
      id,
      assistantKey: input.assistantKey,
      revision,
      systemPrompt: input.systemPrompt,
      isActive: false,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    }).onConflictDoNothing();
    const created = await findAssistantPromptRevision(db, id);
    if (!created) continue;

    await db.batch([
      db.update(assistantPromptRevisions)
        .set({ isActive: false })
        .where(eq(assistantPromptRevisions.assistantKey, input.assistantKey)),
      db.update(assistantPromptRevisions)
        .set({ isActive: true })
        .where(eq(assistantPromptRevisions.id, id)),
    ]);
    const active = await findAssistantPromptRevision(db, id);
    if (active) return active;
  }
  throw new Error("建立 prompt revision 失敗，請稍後再試。");
}

export async function recordAssistantRun(
  db: Database,
  input: {
    id: string;
    channel: AssistantChannel;
    /** 哪個 bot 跑的。`channel` 只說得出 surface，多帳號之後稽核要靠這兩個。 */
    assistantKey?: string;
    channelKey?: string;
    sessionId?: string;
    groupId?: string;
    model: string;
    promptRevisionId: string;
    inputChars: number;
    outputChars: number;
    usage: AssistantUsage;
    status: AssistantRunStatus;
    durationMs: number;
    actorId?: string;
    errorMessage?: string;
    toolCalls: RecordedToolCall[];
  },
): Promise<void> {
  const run = db.insert(assistantRuns).values({
    id: input.id,
    channel: input.channel,
    assistantKey: input.assistantKey,
    channelKey: input.channelKey,
    sessionId: input.sessionId,
    groupId: input.groupId,
    model: input.model,
    promptRevisionId: input.promptRevisionId,
    inputChars: input.inputChars,
    outputChars: input.outputChars,
    promptTokens: input.usage.promptTokens,
    candidateTokens: input.usage.candidateTokens,
    totalTokens: input.usage.totalTokens,
    status: input.status,
    durationMs: input.durationMs,
    actorId: input.actorId,
    errorMessage: input.errorMessage,
  });
  const calls = input.toolCalls.map((call) => db.insert(assistantToolCalls).values({
    id: crypto.randomUUID(),
    runId: input.id,
    toolKey: call.toolKey,
    status: call.status,
    durationMs: call.durationMs,
    errorMessage: call.errorMessage,
  }));
  await db.batch([run, ...calls]);
}


export type AssistantGroupToolMode = "inherit" | "custom";

export function isAssistantGroupToolMode(value: unknown): value is AssistantGroupToolMode {
  return value === "inherit" || value === "custom";
}

/** 這個 channel 被授權的工具。沒有列就是什麼都不給。 */
export async function listAssistantChannelTools(db: Database, channelKey: string): Promise<AssistantChannelTool[]> {
  return db
    .select()
    .from(assistantChannelTools)
    .where(eq(assistantChannelTools.channelKey, channelKey))
    .orderBy(asc(assistantChannelTools.toolKey));
}

/**
 * 整批覆寫某個 channel 的白名單。
 *
 * 收回一個工具時靠 `assistant_chat_tools` 的 ON DELETE CASCADE 把底下所有對話的授權一起
 * 帶走——這裡刻意不自己清對話層，那是外鍵的工作，手寫容易漏。
 */
export async function setAssistantChannelTools(
  db: Database,
  input: { channelKey: string; toolKeys: string[]; updatedBy: string },
): Promise<AssistantChannelTool[]> {
  const wanted = [...new Set(input.toolKeys)];
  const existing = await listAssistantChannelTools(db, input.channelKey);
  const removed = existing.filter((row) => !wanted.includes(row.toolKey));
  const added = wanted.filter((key) => !existing.some((row) => row.toolKey === key));

  if (removed.length) {
    await db.delete(assistantChannelTools).where(inArray(assistantChannelTools.id, removed.map((row) => row.id)));
  }
  if (added.length) {
    const now = new Date().toISOString();
    await db.insert(assistantChannelTools).values(added.map((toolKey) => ({
      id: crypto.randomUUID(),
      channelKey: input.channelKey,
      toolKey,
      createdBy: input.updatedBy,
      createdAt: now,
    }))).onConflictDoNothing();
  }
  return listAssistantChannelTools(db, input.channelKey);
}

/** 某個對話被授權的工具鍵值。只有 `toolMode = "custom"` 的群組會用到。 */
export async function listAssistantChatToolKeys(db: Database, groupId: string): Promise<string[]> {
  const rows = await db
    .select({ toolKey: assistantChannelTools.toolKey })
    .from(assistantChatTools)
    .innerJoin(assistantChannelTools, eq(assistantChatTools.channelToolId, assistantChannelTools.id))
    .where(eq(assistantChatTools.groupId, groupId))
    .orderBy(asc(assistantChannelTools.toolKey));
  return rows.map((row) => row.toolKey);
}

/**
 * 整批覆寫某個對話的白名單。
 *
 * 只認得 channel 已經授權的工具：對話層存的是 `assistant_channel_tools` 的列 id，超出
 * channel 的鍵值在這裡就找不到對應，會被安靜地忽略——這是刻意的，因為「對話不可能超過
 * channel」是這套設計的核心保證，不該讓呼叫端有辦法繞過。
 */
export async function setAssistantChatTools(
  db: Database,
  input: { channelKey: string; groupId: string; toolKeys: string[]; updatedBy: string },
): Promise<string[]> {
  const grants = await listAssistantChannelTools(db, input.channelKey);
  const wanted = grants.filter((grant) => input.toolKeys.includes(grant.toolKey));

  await db.delete(assistantChatTools).where(eq(assistantChatTools.groupId, input.groupId));
  if (wanted.length) {
    const now = new Date().toISOString();
    await db.insert(assistantChatTools).values(wanted.map((grant) => ({
      id: crypto.randomUUID(),
      groupId: input.groupId,
      channelToolId: grant.id,
      createdBy: input.updatedBy,
      createdAt: now,
    }))).onConflictDoNothing();
  }
  return listAssistantChatToolKeys(db, input.groupId);
}

export async function setAssistantGroupToolMode(
  db: Database,
  input: { channelKey: string; id: string; toolMode: AssistantGroupToolMode },
): Promise<AssistantLineGroup | null> {
  await db.update(assistantLineGroups)
    .set({ toolMode: input.toolMode, updatedAt: new Date().toISOString() })
    .where(and(eq(assistantLineGroups.channelKey, input.channelKey), eq(assistantLineGroups.id, input.id)));
  return findAssistantLineGroup(db, { channelKey: input.channelKey, id: input.id });
}

/**
 * 一個 LINE 對話實際拿得到的工具鍵值。**三層的交集，缺一不可。**
 *
 * 1. `assistant_tool_configs.status = 'enabled'`——這個工具在平台上活著嗎。
 *    `development` 代表「只能在 Sandbox 驗證」，不該出現在線上。
 * 2. `assistant_channel_tools`——這個 bot 能用嗎。LINE 這條路真正的授權來源。
 * 3. `assistant_chat_tools`——這個對話能用嗎。只有 `toolMode = "custom"` 才看。
 *
 * 三層都在這裡收斂成一個答案，呼叫端不要自己再拼一次；漏掉任何一層都是安靜地放行。
 */
export async function resolveLineToolKeys(
  db: Database,
  input: { channelKey: string; groupId: string; toolMode: string },
): Promise<string[]> {
  const grants = await listAssistantChannelTools(db, input.channelKey);
  if (!grants.length) return [];

  const configs = await listAssistantToolConfigs(db);
  const enabled = new Set(configs.filter((config) => config.status === "enabled").map((config) => config.key));

  const channelKeys = grants.map((grant) => grant.toolKey).filter((key) => enabled.has(key));
  if (input.toolMode !== "custom") return channelKeys;

  const chatKeys = new Set(await listAssistantChatToolKeys(db, input.groupId));
  return channelKeys.filter((key) => chatKeys.has(key));
}
