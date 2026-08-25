import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Database } from "./client.js";
import { mediaObjects, type MediaObject } from "./schema/media.js";

export interface MediaObjectInput {
  objectKey: string;
  namespace: string;
  scopeKey?: string;
  filename?: string;
  contentType: string;
  size: number;
  checksum: string;
  createdBy?: string | null;
  expiresAt?: string | null;
}

export async function recordMediaObject(db: Database, input: MediaObjectInput): Promise<MediaObject> {
  await db.insert(mediaObjects).values({
    objectKey: input.objectKey,
    namespace: input.namespace,
    scopeKey: input.scopeKey ?? "",
    filename: input.filename ?? "",
    contentType: input.contentType,
    size: input.size,
    checksum: input.checksum,
    createdBy: input.createdBy ?? null,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });
  const [row] = await db.select().from(mediaObjects).where(eq(mediaObjects.objectKey, input.objectKey)).limit(1);
  if (!row) throw new Error("保存 media metadata 後找不到資料。");
  return row;
}

export async function findMediaObject(db: Database, objectKey: string): Promise<MediaObject | null> {
  const [row] = await db.select().from(mediaObjects).where(eq(mediaObjects.objectKey, objectKey)).limit(1);
  return row ?? null;
}

export async function deleteMediaObject(db: Database, objectKey: string): Promise<void> {
  await db.delete(mediaObjects).where(eq(mediaObjects.objectKey, objectKey));
}

export async function listExpiredMediaObjects(
  db: Database,
  now = new Date().toISOString(),
  limit = 100,
): Promise<MediaObject[]> {
  return db
    .select()
    .from(mediaObjects)
    .where(and(isNotNull(mediaObjects.expiresAt), lte(mediaObjects.expiresAt, now)))
    .limit(Math.min(Math.max(Math.floor(limit), 1), 500));
}
