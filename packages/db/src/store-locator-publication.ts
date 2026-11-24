import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { storeLocatorPublication } from "./schema/reports.js";

import type { StoreLocatorPublicationStatus } from "./store-locator-publication-fields.js";
export type { StoreLocatorPublicationStatus } from "./store-locator-publication-fields.js";

/** 與據點異動放在同一個 batch，避免存檔成功卻遺失重試工作。 */
export function dirtyStoreLocatorPublication(db: Database) {
  return db.insert(storeLocatorPublication).values({ id: "public", revision: 1 })
    .onConflictDoUpdate({ target: storeLocatorPublication.id, set: { revision: sql`${storeLocatorPublication.revision} + 1`, error: null } });
}

export async function ensureStoreLocatorPublication(db: Database) {
  await db.insert(storeLocatorPublication).values({ id: "public", revision: 1 }).onConflictDoNothing();
}

export async function getStoreLocatorPublication(db: Database): Promise<StoreLocatorPublicationStatus> {
  const [row] = await db.select().from(storeLocatorPublication).where(eq(storeLocatorPublication.id, "public")).limit(1);
  return {
    revision: row?.revision ?? 0, publishedRevision: row?.publishedRevision ?? 0,
    publishedAt: row?.publishedAt ?? null, error: row?.error ?? null,
    pending: !row?.publishedAt || row.revision !== row.publishedRevision,
  };
}

export async function settleStoreLocatorPublication(db: Database, revision: number, error: string | null) {
  await db.update(storeLocatorPublication).set(error === null
    ? { publishedRevision: revision, publishedAt: new Date().toISOString(), error: null }
    : { error })
    .where(sql`${storeLocatorPublication.id} = 'public' AND ${storeLocatorPublication.revision} = ${revision}`);
}
