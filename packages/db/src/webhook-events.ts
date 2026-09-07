import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { cyberbizWebhookEvents } from "./schema/crm.js";

export type CyberbizWebhookEntityType = "customer" | "product";

export interface ClaimWebhookEventInput {
  id: string;
  topic: string;
  entityType: CyberbizWebhookEntityType;
  externalEntityId?: string | null;
  cyberbizCustomerId?: string | null;
  payloadJson: string;
}

export type ClaimWebhookEventResult =
  | { claimed: true }
  | { claimed: false; status: string };

/**
 * 所有 CYBERBIZ webhook 的唯一入口 claim。
 *
 * 會員與商品共用同一張表、同一個內容雜湊主鍵，才能讓重送不會因為分流而
 * 產生兩套去重與補跑規則。INSERT 本身就是 claim，不可先 SELECT 再 INSERT。
 */
export async function claimCyberbizWebhookEvent(
  db: Database,
  input: ClaimWebhookEventInput,
): Promise<ClaimWebhookEventResult> {
  const inserted = await db
    .insert(cyberbizWebhookEvents)
    .values({
      id: input.id,
      topic: input.topic,
      status: "processing",
      entityType: input.entityType,
      externalEntityId: input.externalEntityId ?? null,
      cyberbizCustomerId: input.cyberbizCustomerId ?? null,
      payloadJson: input.payloadJson,
    })
    .onConflictDoNothing();

  if ((inserted.meta?.changes ?? 0) > 0) return { claimed: true };

  const [existing] = await db
    .select({ status: cyberbizWebhookEvents.status })
    .from(cyberbizWebhookEvents)
    .where(eq(cyberbizWebhookEvents.id, input.id))
    .limit(1);
  if (!existing) throw new Error("webhook 去重後找不到既有事件。");
  return { claimed: false, status: existing.status };
}

/**
 * 以單一 UPDATE claim 一筆 failed 事件，避免補跑期間再被另一個排程重複處理。
 */
export async function claimFailedCyberbizWebhookEvent(
  db: Database,
  id: string,
  entityType: CyberbizWebhookEntityType,
): Promise<boolean> {
  const updated = await db
    .update(cyberbizWebhookEvents)
    .set({
      status: "processing",
      attempts: sql`${cyberbizWebhookEvents.attempts} + 1`,
      lastError: null,
      processedAt: null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(
      eq(cyberbizWebhookEvents.id, id),
      eq(cyberbizWebhookEvents.entityType, entityType),
      eq(cyberbizWebhookEvents.status, "failed"),
    ));
  return (updated.meta?.changes ?? 0) > 0;
}
