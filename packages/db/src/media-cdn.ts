import { and, count, desc, eq, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { mediaCdnBlobs, mediaCdnImages, type MediaCdnImage } from "./schema/media-cdn.js";

export interface MediaCdnFileInput {
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}

export async function registerMediaCdnBlob(db: Database, objectKey: string) {
  await db.insert(mediaCdnBlobs).values({ objectKey, createdAt: new Date().toISOString() });
}

export async function createMediaCdnImage(db: Database, input: MediaCdnFileInput & { id: string; name: string; createdBy: string }) {
  const now = new Date().toISOString();
  const [image] = await db.insert(mediaCdnImages).values({ ...input, createdAt: now, updatedAt: now }).returning();
  return image!;
}

export async function findMediaCdnImage(db: Database, id: string) {
  const [image] = await db.select().from(mediaCdnImages).where(eq(mediaCdnImages.id, id)).limit(1);
  return image ?? null;
}

export async function listMediaCdnImages(db: Database, query: { search?: string; type?: string; page: number; deleted?: boolean }) {
  const search = (query.search ?? "").trim().slice(0, 100);
  const filters = and(
    query.deleted ? undefined : isNull(mediaCdnImages.deletedAt),
    query.type ? eq(mediaCdnImages.contentType, query.type) : undefined,
    search ? or(sql`instr(lower(${mediaCdnImages.name}), lower(${search})) > 0`, sql`instr(lower(${mediaCdnImages.filename}), lower(${search})) > 0`) : undefined,
  );
  const [total] = await db.select({ count: count() }).from(mediaCdnImages).where(filters);
  const images = await db.select().from(mediaCdnImages).where(filters).orderBy(desc(mediaCdnImages.updatedAt), desc(mediaCdnImages.id)).limit(24).offset((query.page - 1) * 24);
  return { images, total: total?.count ?? 0, page: query.page, pageSize: 24 };
}

export async function replaceMediaCdnImage(db: Database, id: string, revision: number, file: MediaCdnFileInput) {
  const [image] = await db.update(mediaCdnImages).set({ ...file, revision: revision + 1, updatedAt: new Date().toISOString(), purgePending: true, purgeError: null })
    .where(and(eq(mediaCdnImages.id, id), eq(mediaCdnImages.revision, revision), isNull(mediaCdnImages.deletedAt))).returning();
  return image ?? null;
}

export async function renameMediaCdnImage(db: Database, id: string, revision: number, name: string) {
  const [image] = await db.update(mediaCdnImages).set({ name, revision: revision + 1, updatedAt: new Date().toISOString(), purgePending: true })
    .where(and(eq(mediaCdnImages.id, id), eq(mediaCdnImages.revision, revision), isNull(mediaCdnImages.deletedAt))).returning();
  return image ?? null;
}

export async function deleteMediaCdnImage(db: Database, id: string, revision: number) {
  const now = new Date().toISOString();
  const [image] = await db.update(mediaCdnImages).set({ objectKey: null, deletedAt: now, updatedAt: now, revision: revision + 1, purgePending: true, purgeError: null })
    .where(and(eq(mediaCdnImages.id, id), eq(mediaCdnImages.revision, revision), isNull(mediaCdnImages.deletedAt))).returning();
  return image ?? null;
}

export async function settleMediaCdnPurge(db: Database, image: Pick<MediaCdnImage, "id" | "revision">, error: string | null) {
  // 舊請求較晚完成時，不可替後來的更新清除 pending。
  await db.update(mediaCdnImages).set({ purgePending: error !== null, purgeError: error })
    .where(and(eq(mediaCdnImages.id, image.id), eq(mediaCdnImages.revision, image.revision)));
}

export async function listPendingMediaCdnPurges(db: Database) {
  return db.select().from(mediaCdnImages).where(eq(mediaCdnImages.purgePending, true)).orderBy(mediaCdnImages.updatedAt).limit(30);
}

export async function listUnusedMediaCdnBlobs(db: Database, before = new Date(Date.now() - 86_400_000).toISOString()) {
  return db.select().from(mediaCdnBlobs).where(and(lte(mediaCdnBlobs.createdAt, before), notInArray(mediaCdnBlobs.objectKey,
    db.select({ key: mediaCdnImages.objectKey }).from(mediaCdnImages).where(isNotNull(mediaCdnImages.objectKey)),
  ))).limit(100);
}

export async function forgetMediaCdnBlob(db: Database, objectKey: string) {
  await db.delete(mediaCdnBlobs).where(eq(mediaCdnBlobs.objectKey, objectKey));
}
