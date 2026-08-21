import { and, desc, eq } from "drizzle-orm";
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
  type AssistantConfig,
  type AssistantPromptRevision,
  type AssistantToolConfig,
} from "./schema/assistant.js";

export type AssistantChannel = "sandbox" | "line";
export type AssistantRunStatus = "success" | "failed";

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
