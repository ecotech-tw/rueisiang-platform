import { and, asc, desc, eq } from "drizzle-orm";
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
  assistantLineChannels,
  assistantLineGroups,
  assistantLineMessages,
  assistantSandboxMessages,
  assistantSandboxSessions,
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

  await db.insert(assistantLineChannels).values({
    assistantKey: input.assistantKey,
    channelId: "",
    channelSecretEncrypted: "",
    accessTokenEncrypted: "",
    displayName: DEFAULT_ASSISTANT_LINE_DISPLAY_NAME,
    enabled: false,
    updatedBy: input.updatedBy ?? "system",
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
    .where(eq(assistantLineChannels.assistantKey, input.assistantKey));
  const channel = await getAssistantLineChannel(db, input.assistantKey);
  if (!channel) throw new Error("更新 LINE channel 設定後找不到資料。");
  return channel;
}

export async function listAssistantLineGroups(db: Database, assistantKey: string): Promise<AssistantLineGroup[]> {
  return db
    .select()
    .from(assistantLineGroups)
    .where(eq(assistantLineGroups.assistantKey, assistantKey))
    .orderBy(desc(assistantLineGroups.discoveredAt));
}

export async function findAssistantLineGroup(db: Database, input: { assistantKey: string; id: string }): Promise<AssistantLineGroup | null> {
  const [row] = await db
    .select()
    .from(assistantLineGroups)
    .where(and(eq(assistantLineGroups.assistantKey, input.assistantKey), eq(assistantLineGroups.id, input.id)))
    .limit(1);
  return row ?? null;
}

export async function upsertAssistantLineGroup(
  db: Database,
  input: { assistantKey: string; lineGroupId: string; displayName?: string },
): Promise<AssistantLineGroup> {
  const id = crypto.randomUUID();
  await db.insert(assistantLineGroups).values({
    id,
    assistantKey: input.assistantKey,
    lineGroupId: input.lineGroupId,
    displayName: input.displayName ?? "",
  }).onConflictDoNothing();
  const [created] = await db
    .select()
    .from(assistantLineGroups)
    .where(and(
      eq(assistantLineGroups.assistantKey, input.assistantKey),
      eq(assistantLineGroups.lineGroupId, input.lineGroupId),
    ))
    .limit(1);
  if (!created) throw new Error("建立 LINE 群組後找不到資料。");
  if (input.displayName && input.displayName !== created.displayName) {
    await db.update(assistantLineGroups)
      .set({ displayName: input.displayName, updatedAt: new Date().toISOString() })
      .where(eq(assistantLineGroups.id, created.id));
    return (await findAssistantLineGroup(db, { assistantKey: input.assistantKey, id: created.id })) ?? created;
  }
  return created;
}

export async function updateAssistantLineGroup(
  db: Database,
  input: { assistantKey: string; id: string; displayName: string; enabled: boolean },
): Promise<AssistantLineGroup | null> {
  await db.update(assistantLineGroups)
    .set({ displayName: input.displayName, enabled: input.enabled, updatedAt: new Date().toISOString() })
    .where(and(eq(assistantLineGroups.assistantKey, input.assistantKey), eq(assistantLineGroups.id, input.id)));
  return findAssistantLineGroup(db, { assistantKey: input.assistantKey, id: input.id });
}

export async function recordAssistantLineMessage(
  db: Database,
  input: {
    assistantKey: string;
    lineGroupId: string;
    sourceType: string;
    webhookEventId: string;
    lineMessageId?: string;
    lineUserId?: string;
    text: string;
  },
): Promise<{ message: AssistantLineMessage; inserted: boolean }> {
  const id = crypto.randomUUID();
  await db.insert(assistantLineMessages).values({ id, ...input }).onConflictDoNothing();
  const [created] = await db.select().from(assistantLineMessages).where(and(
    eq(assistantLineMessages.assistantKey, input.assistantKey),
    eq(assistantLineMessages.webhookEventId, input.webhookEventId),
  )).limit(1);
  if (!created) throw new Error("記錄 LINE 訊息後找不到資料。");
  return { message: created, inserted: created.id === id };
}

export async function listAssistantLineMessages(
  db: Database,
  input: { assistantKey: string; lineGroupId: string; limit?: number },
): Promise<AssistantLineMessage[]> {
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
  const rows = await db
    .select()
    .from(assistantLineMessages)
    .where(and(
      eq(assistantLineMessages.assistantKey, input.assistantKey),
      eq(assistantLineMessages.lineGroupId, input.lineGroupId),
    ))
    .orderBy(desc(assistantLineMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function createAssistantSandboxSession(
  db: Database,
  input: { assistantKey: string; createdBy: string; model: string; promptRevisionId: string },
): Promise<AssistantSandboxSession> {
  const id = crypto.randomUUID();
  await db.insert(assistantSandboxSessions).values({
    id,
    assistantKey: input.assistantKey,
    createdBy: input.createdBy,
    model: input.model,
    promptRevisionId: input.promptRevisionId,
    status: "open",
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
    .orderBy(desc(assistantSandboxSessions.updatedAt))
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
    .orderBy(asc(assistantSandboxMessages.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
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
  },
): Promise<AssistantSandboxMessage> {
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(assistantSandboxMessages).values({
      id,
      sessionId: input.sessionId,
      role: input.role,
      text: input.text,
      model: input.model ?? "",
      thoughts: input.thoughts ?? "",
      toolCalls: JSON.stringify(input.toolCalls ?? []),
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
    });
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
    });
  }

  const existingTools = await db.select({ key: assistantToolConfigs.key }).from(assistantToolConfigs);
  const existing = new Set(existingTools.map((tool) => tool.key));
  for (const key of input.toolKeys) {
    if (existing.has(key)) continue;
    await db.insert(assistantToolConfigs).values({ key, status: "development", updatedBy: "system" });
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
  const revisions = await listAssistantPromptRevisions(db, input.assistantKey);
  const revision = (revisions[0]?.revision ?? 0) + 1;
  const id = crypto.randomUUID();
  await db.batch([
    db.update(assistantPromptRevisions)
      .set({ isActive: false })
      .where(eq(assistantPromptRevisions.assistantKey, input.assistantKey)),
    db.insert(assistantPromptRevisions).values({
      id,
      assistantKey: input.assistantKey,
      revision,
      systemPrompt: input.systemPrompt,
      isActive: true,
      createdBy: input.createdBy,
    }),
  ]);
  const created = await findAssistantPromptRevision(db, id);
  if (!created) throw new Error("建立 prompt revision 後找不到資料。");
  return created;
}

export async function recordAssistantRun(
  db: Database,
  input: {
    id: string;
    channel: AssistantChannel;
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
