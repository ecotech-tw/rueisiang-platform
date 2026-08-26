import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
  assistantLineReplyBackups,
  assistantLinePushDeliveries,
  assistantLineQueueJobs,
  assistantSandboxMessages,
  assistantSandboxSessions,
  type AssistantChannelTool,
  type AssistantConfig,
  type AssistantLineChannel,
  type AssistantLineGroup,
  type AssistantLineMessage,
  type AssistantLineReplyBackup,
  type AssistantLinePushDelivery,
  type AssistantLineQueueJob,
  type AssistantPromptRevision,
  type AssistantSandboxMessage,
  type AssistantSandboxSession,
  type AssistantToolConfig,
} from "./schema/assistant.js";

export type AssistantChannel = "sandbox" | "line";
export type AssistantRunStatus = "success" | "failed";
export type AssistantSandboxSessionStatus = "open" | "closed";
export type AssistantSandboxMessageRole = "user" | "model";
export type AssistantLineSourceType = "group" | "room" | "user";
export const DEFAULT_ASSISTANT_LINE_DISPLAY_NAME = "Rueisiang 小香";

export interface StoredMediaAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
  checksum: string;
  expiresAt?: string | null;
}

/**
 * 取得（必要時建立）某個 assistant 的 LINE channel。
 *
 * 現階段一個 assistant 只有一個 channel，所以新建時 `channelKey` 直接沿用 `assistantKey`。
 * 值相同不代表概念相同——關聯一律走 `channelKey`，官網客服當第二個 channel 進來時，
 * 這裡改成產新的鍵值即可，既有資料不必再搬。
 * `defaultToolKeys` 只在首次建立 channel 時套用；後續管理者收回的工具不會在每次 request 被補回。
 */
export async function ensureAssistantLineChannel(
  db: Database,
  input: { assistantKey: string; updatedBy?: string; defaultToolKeys?: readonly string[] },
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

  const defaultToolKeys = [...new Set(input.defaultToolKeys ?? [])];
  if (defaultToolKeys.length) {
    const now = new Date().toISOString();
    await db.insert(assistantChannelTools).values(defaultToolKeys.map((toolKey) => ({
      id: crypto.randomUUID(),
      channelKey: created.channelKey,
      toolKey,
      createdBy: input.updatedBy ?? "system",
      createdAt: now,
    }))).onConflictDoNothing();
  }
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
  input: { channelKey: string; lineGroupId: string; sourceType?: AssistantLineSourceType; displayName?: string },
): Promise<AssistantLineGroup> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(assistantLineGroups).values({
    id,
    channelKey: input.channelKey,
    lineGroupId: input.lineGroupId,
    sourceType: input.sourceType ?? "group",
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
  if (!created) throw new Error("建立 LINE 對話後找不到資料。");
  const sourceTypeChanged = input.sourceType !== undefined && input.sourceType !== created.sourceType;
  if ((input.displayName && input.displayName !== created.displayName) || sourceTypeChanged) {
    await db.update(assistantLineGroups)
      .set({
        ...(input.displayName && input.displayName !== created.displayName ? { displayName: input.displayName } : {}),
        ...(sourceTypeChanged ? { sourceType: input.sourceType } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(assistantLineGroups.id, created.id));
    return (await findAssistantLineGroup(db, { channelKey: input.channelKey, id: created.id })) ?? created;
  }
  return created;
}

/**
 * 重設 LINE 對話的模型上下文，但不刪掉監控歷史。
 *
 * LINE 沒有像 Sandbox 那樣的 session row；用時間邊界切開上下文即可，這樣管理員仍能
 * 追查重設前發生過什麼，也不會讓「重設」變成不可逆的刪除操作。
 */
export async function resetAssistantLineContext(
  db: Database,
  input: { channelKey: string; id: string },
): Promise<AssistantLineGroup | null> {
  const now = new Date().toISOString();
  await db.update(assistantLineGroups)
    .set({ contextResetAt: now, updatedAt: now })
    .where(and(eq(assistantLineGroups.channelKey, input.channelKey), eq(assistantLineGroups.id, input.id)));
  return findAssistantLineGroup(db, { channelKey: input.channelKey, id: input.id });
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
 * 從 LINE 取回的名稱與大頭貼寫回對話。
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
 * 這個對話現在該不該去跟 LINE 要一次名稱與大頭貼。
 *
 * 不是每則訊息都打：名稱很少改，而大頭貼網址雖然會過期，重抓一次也只是為了顯示。
 * 每則訊息都打一次只是在燒 LINE 的速率限制，換不到任何東西。
 *
 * 還沒有名字的（剛被發現、或被 0028 救回來的）例外，那種要立刻補上——只有一串 ID
 * 的對話在後台根本認不出是哪一個。
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
    quotedMessageId?: string;
    text: string;
    attachments?: StoredMediaAttachment[];
    queueRequired?: boolean;
  },
): Promise<{ message: AssistantLineMessage; inserted: boolean }> {
  const [existing] = await db.select().from(assistantLineMessages).where(and(
    eq(assistantLineMessages.channelKey, input.channelKey),
    eq(assistantLineMessages.webhookEventId, input.webhookEventId),
  )).limit(1);
  if (existing) return { message: existing, inserted: false };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.update(assistantLineGroups)
      .set({
        nextMessageSequence: sql`${assistantLineGroups.nextMessageSequence} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(assistantLineGroups.channelKey, input.channelKey),
        eq(assistantLineGroups.lineGroupId, input.lineGroupId),
      )),
    db.insert(assistantLineMessages).values({
      id,
      channelKey: input.channelKey,
      lineGroupId: input.lineGroupId,
      sourceType: input.sourceType,
      webhookEventId: input.webhookEventId,
      lineMessageId: input.lineMessageId,
      lineUserId: input.lineUserId,
      quotedMessageId: input.quotedMessageId,
      text: input.text,
      attachments: JSON.stringify(input.attachments ?? []),
      sequence: sql<number>`(
        SELECT ${assistantLineGroups.nextMessageSequence}
        FROM ${assistantLineGroups}
        WHERE ${assistantLineGroups.channelKey} = ${input.channelKey}
          AND ${assistantLineGroups.lineGroupId} = ${input.lineGroupId}
      )`,
      queueRequired: input.queueRequired ?? false,
      createdAt: now,
    }).onConflictDoNothing(),
  ]);
  const [created] = await db.select().from(assistantLineMessages).where(and(
    eq(assistantLineMessages.channelKey, input.channelKey),
    eq(assistantLineMessages.webhookEventId, input.webhookEventId),
  )).limit(1);
  if (!created) throw new Error("記錄 LINE 訊息後找不到資料。");
  return { message: created, inserted: created.id === id };
}

export async function getAssistantLineMessage(
  db: Database,
  input: { channelKey: string; webhookEventId: string },
): Promise<AssistantLineMessage | null> {
  const [message] = await db.select().from(assistantLineMessages).where(and(
    eq(assistantLineMessages.channelKey, input.channelKey),
    eq(assistantLineMessages.webhookEventId, input.webhookEventId),
  )).limit(1);
  return message ?? null;
}

export async function getAssistantLineMessageByLineMessageId(
  db: Database,
  input: { channelKey: string; lineGroupId: string; lineMessageId: string },
): Promise<AssistantLineMessage | null> {
  const [message] = await db.select().from(assistantLineMessages).where(and(
    eq(assistantLineMessages.channelKey, input.channelKey),
    eq(assistantLineMessages.lineGroupId, input.lineGroupId),
    eq(assistantLineMessages.lineMessageId, input.lineMessageId),
  )).limit(1);
  return message ?? null;
}

export async function updateAssistantLineMessageAttachments(
  db: Database,
  input: { channelKey: string; webhookEventId: string; attachments: StoredMediaAttachment[] },
): Promise<AssistantLineMessage> {
  await db.update(assistantLineMessages)
    .set({ attachments: JSON.stringify(input.attachments) })
    .where(and(
      eq(assistantLineMessages.channelKey, input.channelKey),
      eq(assistantLineMessages.webhookEventId, input.webhookEventId),
    ));
  const message = await getAssistantLineMessage(db, input);
  if (!message) throw new Error("更新 LINE 圖片 metadata 後找不到訊息。");
  return message;
}

export async function recordAssistantLineReplyBackup(
  db: Database,
  input: {
    runId: string;
    channelKey: string;
    groupId: string;
    lineGroupId: string;
    sourceType: string;
    webhookEventId: string;
    questionText: string;
    responseText?: string;
    model?: string;
    status?: "ready" | "failed";
    reason?: string;
    errorMessage?: string;
  },
): Promise<AssistantLineReplyBackup> {
  const id = crypto.randomUUID();
  await db.insert(assistantLineReplyBackups).values({
    id,
    runId: input.runId,
    channelKey: input.channelKey,
    groupId: input.groupId,
    lineGroupId: input.lineGroupId,
    sourceType: input.sourceType,
    webhookEventId: input.webhookEventId,
    questionText: input.questionText,
    responseText: input.responseText ?? "",
    model: input.model ?? "",
    status: input.status ?? "ready",
    reason: input.reason ?? "reply_token_deadline",
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    createdAt: new Date().toISOString(),
  }).onConflictDoNothing();
  const [backup] = await db
    .select()
    .from(assistantLineReplyBackups)
    .where(eq(assistantLineReplyBackups.runId, input.runId))
    .limit(1);
  if (!backup) throw new Error("儲存 LINE 備用回覆後找不到資料。");
  return backup;
}

export async function getAssistantLineReplyBackup(
  db: Database,
  runId: string,
): Promise<AssistantLineReplyBackup | null> {
  const [backup] = await db
    .select()
    .from(assistantLineReplyBackups)
    .where(eq(assistantLineReplyBackups.runId, runId))
    .limit(1);
  return backup ?? null;
}

/**
 * Queue lock 要覆蓋最慢的一輪 model + tools 執行時間；stale requeue 仍會另外
 * 檢查 lockedUntil，避免排程在活工作尚未結束時啟動第二個 consumer。
 */
export const ASSISTANT_LINE_QUEUE_LOCK_MS = 10 * 60_000;
/** wrangler max_retries = 3，包含第一次投遞後最多四次 consumer attempt。 */
export const ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS = 4;

export type AssistantLineQueueJobStatus =
  | "pending"
  | "enqueued"
  | "processing"
  | "completed"
  | "failed"
  | "ambiguous";

export async function upsertAssistantLineQueueJob(
  db: Database,
  input: { channelKey: string; webhookEventId: string; payloadEncrypted: string },
): Promise<{ job: AssistantLineQueueJob; shouldEnqueue: boolean }> {
  const [existing] = await db
    .select()
    .from(assistantLineQueueJobs)
    .where(and(
      eq(assistantLineQueueJobs.channelKey, input.channelKey),
      eq(assistantLineQueueJobs.webhookEventId, input.webhookEventId),
    ))
    .limit(1);

  if (existing) {
    if (existing.status !== "pending") return { job: existing, shouldEnqueue: false };
    await db
      .update(assistantLineQueueJobs)
      .set({ payloadEncrypted: input.payloadEncrypted, updatedAt: new Date().toISOString(), lastError: null })
      .where(eq(assistantLineQueueJobs.id, existing.id));
    const [updated] = await db.select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.id, existing.id)).limit(1);
    if (!updated) throw new Error("更新 LINE Queue outbox 後找不到資料。");
    return { job: updated, shouldEnqueue: true };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(assistantLineQueueJobs).values({
    id,
    channelKey: input.channelKey,
    webhookEventId: input.webhookEventId,
    payloadEncrypted: input.payloadEncrypted,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const [created] = await db.select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.id, id)).limit(1);
  if (created) return { job: created, shouldEnqueue: true };

  // Two webhook retries can race on the unique event key; return the winner's row.
  const [raced] = await db
    .select()
    .from(assistantLineQueueJobs)
    .where(and(
      eq(assistantLineQueueJobs.channelKey, input.channelKey),
      eq(assistantLineQueueJobs.webhookEventId, input.webhookEventId),
    ))
    .limit(1);
  if (!raced) throw new Error("建立 LINE Queue outbox 後找不到資料。");
  return { job: raced, shouldEnqueue: raced.status === "pending" };
}

export async function markAssistantLineQueueJobEnqueued(db: Database, id: string): Promise<void> {
  await db
    .update(assistantLineQueueJobs)
    .set({ status: "enqueued", updatedAt: new Date().toISOString(), lastError: null })
    .where(and(eq(assistantLineQueueJobs.id, id), eq(assistantLineQueueJobs.status, "pending")));
}

export async function claimAssistantLineQueueJob(
  db: Database,
  input: { channelKey: string; webhookEventId: string },
): Promise<
  | { job: AssistantLineQueueJob; claimToken: string }
  | { done: true; terminal?: "failed" | "ambiguous" }
  | null
> {
  const [current] = await db
    .select()
    .from(assistantLineQueueJobs)
    .where(and(
      eq(assistantLineQueueJobs.channelKey, input.channelKey),
      eq(assistantLineQueueJobs.webhookEventId, input.webhookEventId),
    ))
    .limit(1);
  if (!current) return null;
  if (current.status === "completed") return { done: true };
  if (current.status === "failed") return { done: true, terminal: "failed" };
  if (current.status === "ambiguous") return { done: true, terminal: "ambiguous" };

  const now = new Date();
  const nowText = now.toISOString();
  const lockedUntil = new Date(now.getTime() + ASSISTANT_LINE_QUEUE_LOCK_MS).toISOString();
  const claimToken = crypto.randomUUID();
  const result = await db
    .update(assistantLineQueueJobs)
    .set({
      status: "processing",
      attempts: sql`${assistantLineQueueJobs.attempts} + 1`,
      claimToken,
      lockedUntil,
      updatedAt: nowText,
    })
    .where(and(
      eq(assistantLineQueueJobs.id, current.id),
      or(
        eq(assistantLineQueueJobs.status, "pending"),
        eq(assistantLineQueueJobs.status, "enqueued"),
        and(
          eq(assistantLineQueueJobs.status, "processing"),
          or(isNull(assistantLineQueueJobs.lockedUntil), lt(assistantLineQueueJobs.lockedUntil, nowText)),
        ),
      ),
    ));
  if ((result.meta?.changes ?? 0) === 0) return { done: true };

  const [claimed] = await db.select().from(assistantLineQueueJobs).where(eq(assistantLineQueueJobs.id, current.id)).limit(1);
  if (!claimed || claimed.claimToken !== claimToken) return { done: true };
  return { job: claimed, claimToken };
}

export async function completeAssistantLineQueueJob(db: Database, input: { id: string; claimToken: string }): Promise<void> {
  await db
    .update(assistantLineQueueJobs)
    .set({ status: "completed", claimToken: null, lockedUntil: null, updatedAt: new Date().toISOString(), lastError: null })
    .where(and(eq(assistantLineQueueJobs.id, input.id), eq(assistantLineQueueJobs.claimToken, input.claimToken)));
}

export async function releaseAssistantLineQueueJob(
  db: Database,
  input: { id: string; claimToken: string; error?: string },
): Promise<void> {
  await db
    .update(assistantLineQueueJobs)
    .set({
      // Queue retry 已由 consumer 的 message.retry() 負責；保留 enqueued，讓 cron outbox
      // 不會把同一個失敗工作再開一條獨立投遞，進而繞過 Queue 的 retry budget。
      status: "enqueued",
      claimToken: null,
      lockedUntil: null,
      updatedAt: new Date().toISOString(),
      lastError: input.error?.slice(0, 1_000) ?? "line_queue_processing_failed",
    })
    .where(and(eq(assistantLineQueueJobs.id, input.id), eq(assistantLineQueueJobs.claimToken, input.claimToken)));
}

/** Queue 已耗盡重試次數；保留資料供稽核，但不再讓排程 outbox 反覆送出。 */
export async function failAssistantLineQueueJob(
  db: Database,
  input: { id: string; claimToken: string; error?: string },
): Promise<void> {
  await db
    .update(assistantLineQueueJobs)
    .set({
      status: "failed",
      claimToken: null,
      lockedUntil: null,
      updatedAt: new Date().toISOString(),
      lastError: input.error?.slice(0, 1_000) ?? "line_queue_retry_limit_exhausted",
    })
    .where(and(eq(assistantLineQueueJobs.id, input.id), eq(assistantLineQueueJobs.claimToken, input.claimToken)));
}

/** LINE retry key 已超過可安全重送的期間；保留工作等待人工／專用 reconciliation。 */
export async function markAssistantLineQueueJobAmbiguous(
  db: Database,
  input: { id: string; claimToken: string; error?: string },
): Promise<void> {
  await db
    .update(assistantLineQueueJobs)
    .set({
      status: "ambiguous",
      claimToken: null,
      lockedUntil: null,
      updatedAt: new Date().toISOString(),
      lastError: input.error?.slice(0, 1_000) ?? "line_push_retry_key_expired_ambiguous",
    })
    .where(and(eq(assistantLineQueueJobs.id, input.id), eq(assistantLineQueueJobs.claimToken, input.claimToken)));
}

/** 把 consumer 在 Worker crash 時留下的鎖放回 pending，並交給排程重新送入 Queue。 */
export async function requeueStaleAssistantLineQueueJobs(
  db: Database,
  input: { olderThan: string },
): Promise<number> {
  const nowText = new Date().toISOString();
  const staleProcessing = and(
    eq(assistantLineQueueJobs.status, "processing"),
    or(isNull(assistantLineQueueJobs.lockedUntil), lt(assistantLineQueueJobs.lockedUntil, nowText)),
  );
  const staleJob = and(
    lt(assistantLineQueueJobs.updatedAt, input.olderThan),
    or(
      // attempts = 0 代表只寫入 D1、Queue.send 尚未被 consumer claim，才需要 outbox 補送。
      and(eq(assistantLineQueueJobs.status, "enqueued"), eq(assistantLineQueueJobs.attempts, 0)),
      staleProcessing,
    ),
  );

  // Worker crash 後若已經耗盡 consumer attempts，直接標 terminal，不能再被 cron 撿回來。
  const exhausted = await db
    .update(assistantLineQueueJobs)
    .set({
      status: "failed",
      claimToken: null,
      lockedUntil: null,
      updatedAt: nowText,
      lastError: "line_queue_retry_limit_exhausted",
    })
    .where(and(staleJob, gt(assistantLineQueueJobs.attempts, ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS - 1)));

  const result = await db
    .update(assistantLineQueueJobs)
    .set({ status: "pending", claimToken: null, lockedUntil: null, updatedAt: nowText })
    .where(and(
      staleJob,
      lt(assistantLineQueueJobs.attempts, ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS),
    ));
  return Number(exhausted.meta?.changes ?? 0) + Number(result.meta?.changes ?? 0);
}

export async function listPendingAssistantLineQueueJobs(
  db: Database,
  limit = 20,
): Promise<AssistantLineQueueJob[]> {
  return db
    .select()
    .from(assistantLineQueueJobs)
    .where(and(
      eq(assistantLineQueueJobs.status, "pending"),
      lt(assistantLineQueueJobs.attempts, ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS),
    ))
    .orderBy(asc(assistantLineQueueJobs.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

/**
 * 以 D1 的條件 upsert 預約本月 Push recipient 數。
 * remoteUsage 是 LINE API 回報的本月用量；本地 reserved 只會取較大的基準，避免漏算其他來源。
 */
export type AssistantLinePushReservation = {
  allowed: boolean;
  delivery: AssistantLinePushDelivery;
  localUsage: number;
  effectiveUsage: number;
};

/**
 * 在 LINE 計費月份的 fixed window 內保守預約收件人數，並為每次 Push 嘗試留下 ledger。
 *
 * reservation 使用單一 `INSERT ... SELECT`，讓 D1 在 statement 層級檢查並增加 fixed-window
 * 用量；Queue 仍由設定檔以 `max_concurrency = 1` 保護同一 conversation 的訊息順序，
 * quota 正確性則由這個 atomic reservation 另外保證。
 * remoteUsage 可能已包含本服務送出的 Push，所以只取本地與遠端較大值，不能相加。
 */
export async function reserveAssistantLinePushDelivery(
  db: Database,
  input: {
    runId: string;
    channelKey: string;
    groupId: string;
    lineGroupId: string;
    sourceType: AssistantLineSourceType;
    windowKey: string;
    remoteUsage: number;
    recipients: number;
    limit: number;
    /** 前置 API 取值失敗時仍留 skipped ledger，不允許實際 Push。 */
    denyReason?: string;
  },
): Promise<AssistantLinePushReservation> {
  const remoteUsage = Math.max(0, Math.floor(input.remoteUsage));
  const recipients = Math.max(1, Math.floor(input.recipients));
  const limit = Math.max(0, Math.floor(input.limit));
  const [existing] = await db
    .select()
    .from(assistantLinePushDeliveries)
    .where(eq(assistantLinePushDeliveries.runId, input.runId))
    .limit(1);
  if (existing) {
    const localUsage = await linePushLocalUsage(db, existing.channelKey, existing.windowKey);
    return {
      allowed: existing.status === "reserved",
      delivery: existing,
      localUsage,
      effectiveUsage: Math.max(localUsage, existing.remoteUsage),
    };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const canReserve = input.denyReason ? 0 : 1;
  const denyReason = input.denyReason ?? "monthly_fixed_window_limit";
  await db.run(sql`
    WITH current_usage AS (
      SELECT coalesce(max(reserved_through), 0) AS local_usage
      FROM assistant_line_push_deliveries
      WHERE channel_key = ${input.channelKey}
        AND window_key = ${input.windowKey}
        AND status IN ('reserved', 'sent', 'failed')
    ), effective_usage AS (
      SELECT max(local_usage, ${remoteUsage}) AS usage
      FROM current_usage
    )
    INSERT INTO assistant_line_push_deliveries (
      id, run_id, channel_key, group_id, line_group_id, source_type, window_key,
      recipient_count, remote_usage, reserved_through, status, reason, created_at, updated_at
    )
    SELECT
      ${id}, ${input.runId}, ${input.channelKey}, ${input.groupId}, ${input.lineGroupId}, ${input.sourceType}, ${input.windowKey},
      ${recipients}, ${remoteUsage},
      CASE WHEN ${canReserve} = 1 AND usage + ${recipients} <= ${limit} THEN usage + ${recipients} ELSE usage END,
      CASE WHEN ${canReserve} = 1 AND usage + ${recipients} <= ${limit} THEN 'reserved' ELSE 'skipped' END,
      CASE WHEN ${canReserve} = 1 AND usage + ${recipients} <= ${limit} THEN '' ELSE ${denyReason} END,
      ${now}, ${now}
    FROM effective_usage
    WHERE NOT EXISTS (
      SELECT 1 FROM assistant_line_push_deliveries WHERE run_id = ${input.runId}
    )
  `);
  const [delivery] = await db
    .select()
    .from(assistantLinePushDeliveries)
    .where(eq(assistantLinePushDeliveries.runId, input.runId))
    .limit(1);
  if (!delivery) throw new Error("建立 LINE Push fixed-window 紀錄後找不到資料。");
  const localUsage = await linePushLocalUsage(db, input.channelKey, input.windowKey);
  return {
    allowed: delivery.status === "reserved",
    delivery,
    localUsage,
    effectiveUsage: Math.max(localUsage, remoteUsage),
  };
}

async function linePushLocalUsage(db: Database, channelKey: string, windowKey: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(max(${assistantLinePushDeliveries.reservedThrough}), 0)` })
    .from(assistantLinePushDeliveries)
    .where(and(
      eq(assistantLinePushDeliveries.channelKey, channelKey),
      eq(assistantLinePushDeliveries.windowKey, windowKey),
      inArray(assistantLinePushDeliveries.status, ["reserved", "sent", "failed"]),
    ));
  return Math.max(0, Number(row?.total ?? 0));
}

export async function markAssistantLinePushDelivery(
  db: Database,
  input: { runId: string; status: "sent" | "failed"; reason?: string },
): Promise<void> {
  await db
    .update(assistantLinePushDeliveries)
    .set({ status: input.status, reason: input.reason ?? "", updatedAt: new Date().toISOString() })
    .where(and(
      eq(assistantLinePushDeliveries.runId, input.runId),
      eq(assistantLinePushDeliveries.status, "reserved"),
    ));
}

export async function listAssistantLineMessages(
  db: Database,
  input: { channelKey: string; lineGroupId: string; contextResetAt?: string | null; limit?: number },
): Promise<AssistantLineMessage[]> {
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
  const conditions = [
    eq(assistantLineMessages.channelKey, input.channelKey),
    eq(assistantLineMessages.lineGroupId, input.lineGroupId),
  ];
  if (input.contextResetAt) conditions.push(gt(assistantLineMessages.createdAt, input.contextResetAt));
  const rows = await db
    .select()
    .from(assistantLineMessages)
    .where(and(...conditions))
    .orderBy(
      desc(assistantLineMessages.sequence),
      sql`CASE WHEN instr(${assistantLineMessages.createdAt}, 'T') > 0 THEN ${assistantLineMessages.createdAt} ELSE replace(${assistantLineMessages.createdAt}, ' ', 'T') || '.000Z' END DESC`,
      desc(assistantLineMessages.id),
    )
    .limit(limit);
  return rows.reverse();
}

/** 找出同一個 LINE 對話中，仍可能尚未完成的較早 Queue 工作，避免 retry 越過前一則訊息。 */
export async function findEarlierAssistantLineQueueJob(
  db: Database,
  input: { channelKey: string; lineGroupId: string; sequence: number },
): Promise<{ sequence: number; webhookEventId: string; status: AssistantLineQueueJobStatus } | null> {
  const [row] = await db
    .select({
      sequence: assistantLineMessages.sequence,
      webhookEventId: assistantLineMessages.webhookEventId,
      status: assistantLineQueueJobs.status,
    })
    .from(assistantLineMessages)
    .leftJoin(assistantLineQueueJobs, and(
      eq(assistantLineQueueJobs.channelKey, assistantLineMessages.channelKey),
      eq(assistantLineQueueJobs.webhookEventId, assistantLineMessages.webhookEventId),
    ))
    .where(and(
      eq(assistantLineMessages.channelKey, input.channelKey),
      eq(assistantLineMessages.lineGroupId, input.lineGroupId),
      eq(assistantLineMessages.queueRequired, true),
      lt(assistantLineMessages.sequence, input.sequence),
      or(
        isNull(assistantLineQueueJobs.status),
        inArray(assistantLineQueueJobs.status, ["pending", "enqueued", "processing"]),
      ),
    ))
    .orderBy(asc(assistantLineMessages.sequence), asc(assistantLineMessages.createdAt), asc(assistantLineMessages.id))
    .limit(1);
  if (!row) return null;
  const status = row.status;
  return {
    sequence: row.sequence,
    webhookEventId: row.webhookEventId,
    status: status === "pending" || status === "enqueued" || status === "processing"
      ? status
      : "pending",
  };
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
    attachments?: StoredMediaAttachment[];
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
      attachments: JSON.stringify(input.attachments ?? []),
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
    // 內建唯讀工具預設直接可用；管理者仍可在後台改成開發中或已停用。
    await db.insert(assistantToolConfigs).values({ key, status: "enabled", updatedBy: "system", updatedAt: now }).onConflictDoNothing();
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
  const [existingRun] = await db
    .select()
    .from(assistantRuns)
    .where(eq(assistantRuns.id, input.id))
    .limit(1);
  const existingToolRows = existingRun
    ? await db.select().from(assistantToolCalls).where(eq(assistantToolCalls.runId, input.id))
    : [];
  const incomingUsageIsEmpty = input.usage.promptTokens === 0
    && input.usage.candidateTokens === 0
    && input.usage.totalTokens === 0;
  const usage = incomingUsageIsEmpty && existingRun
    ? {
        promptTokens: existingRun.promptTokens ?? 0,
        candidateTokens: existingRun.candidateTokens ?? 0,
        totalTokens: existingRun.totalTokens ?? 0,
      }
    : input.usage;
  const outputChars = input.outputChars === 0 && existingRun?.outputChars
    ? existingRun.outputChars
    : input.outputChars;
  const toolCalls = input.toolCalls.length > 0
    ? input.toolCalls
    : existingToolRows.map((call) => ({
        toolKey: call.toolKey,
        status: call.status === "failed" ? "failed" as const : "success" as const,
        durationMs: call.durationMs,
        ...(call.errorMessage ? { errorMessage: call.errorMessage } : {}),
      }));

  await db.insert(assistantRuns).values({
    id: input.id,
    channel: input.channel,
    assistantKey: input.assistantKey,
    channelKey: input.channelKey,
    sessionId: input.sessionId,
    groupId: input.groupId,
    model: input.model,
    promptRevisionId: input.promptRevisionId,
    inputChars: input.inputChars,
    outputChars,
    promptTokens: usage.promptTokens,
    candidateTokens: usage.candidateTokens,
    totalTokens: usage.totalTokens,
    status: input.status,
    durationMs: input.durationMs,
    actorId: input.actorId,
    errorMessage: input.errorMessage,
  }).onConflictDoNothing();

  // Retry 同一 runId 時要把第一次 failed 的 audit 更新成最後結果；tool rows 先清掉再重建，
  // 避免每次 Queue retry 都多一份相同的 tool call。
  await db.update(assistantRuns).set({
    channel: input.channel,
    assistantKey: input.assistantKey ?? null,
    channelKey: input.channelKey ?? null,
    sessionId: input.sessionId ?? null,
    groupId: input.groupId ?? null,
    model: input.model,
    promptRevisionId: input.promptRevisionId,
    inputChars: input.inputChars,
    outputChars,
    promptTokens: usage.promptTokens,
    candidateTokens: usage.candidateTokens,
    totalTokens: usage.totalTokens,
    status: input.status,
    durationMs: input.durationMs,
    actorId: input.actorId ?? null,
    errorMessage: input.errorMessage ?? null,
  }).where(eq(assistantRuns.id, input.id));

  await db.delete(assistantToolCalls).where(eq(assistantToolCalls.runId, input.id));
  if (toolCalls.length > 0) {
    await Promise.all(toolCalls.map((call) => db.insert(assistantToolCalls).values({
      id: crypto.randomUUID(),
      runId: input.id,
      toolKey: call.toolKey,
      status: call.status,
      durationMs: call.durationMs,
      errorMessage: call.errorMessage,
    })));
  }
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

/** 某個對話被授權的工具鍵值。只有 `toolMode = "custom"` 的對話會用到。 */
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
