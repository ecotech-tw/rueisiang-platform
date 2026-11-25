import { and, asc, count, desc, eq, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { toDbTimestamp } from "./db-timestamp.js";
import type { MediaImageSortField } from "./media-cdn-fields.js";
import { mediaCdnBlobs, mediaCdnImages, type MediaCdnImage } from "./schema/media-cdn.js";
import { julian } from "./db-time-sql.js";

export interface MediaCdnFileInput {
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}

export async function registerMediaCdnBlob(db: Database, objectKey: string) {
  await db.insert(mediaCdnBlobs).values({ objectKey, createdAt: toDbTimestamp() });
}

export async function createMediaCdnImage(db: Database, input: MediaCdnFileInput & { id: string; name: string; createdBy: string }) {
  const now = toDbTimestamp();
  const [image] = await db.insert(mediaCdnImages).values({ ...input, createdAt: now, updatedAt: now }).returning();
  return image!;
}

export async function findMediaCdnImage(db: Database, id: string) {
  const [image] = await db.select().from(mediaCdnImages).where(eq(mediaCdnImages.id, id)).limit(1);
  return image ?? null;
}

export async function listMediaCdnImages(db: Database, query: { search?: string; type?: string; page: number; deleted?: boolean; sort?: MediaImageSortField; direction?: "asc" | "desc" }) {
  const search = (query.search ?? "").trim().slice(0, 100);
  const filters = and(
    query.deleted ? undefined : isNull(mediaCdnImages.deletedAt),
    query.type ? eq(mediaCdnImages.contentType, query.type) : undefined,
    search ? or(sql`instr(lower(${mediaCdnImages.name}), lower(${search})) > 0`, sql`instr(lower(${mediaCdnImages.filename}), lower(${search})) > 0`) : undefined,
  );
  const [total] = await db.select({ count: count() }).from(mediaCdnImages).where(filters);
  const columns = {
    name: sql`${mediaCdnImages.name} COLLATE NOCASE`,
    contentType: mediaCdnImages.contentType,
    pixels: sql`${mediaCdnImages.width} * ${mediaCdnImages.height}`,
    size: mediaCdnImages.size,
    updatedAt: mediaCdnImages.updatedAt,
    createdAt: mediaCdnImages.createdAt,
    status: sql`CASE WHEN ${mediaCdnImages.purgePending} = 1 THEN 1 WHEN ${mediaCdnImages.deletedAt} IS NOT NULL THEN 2 ELSE 0 END`,
  };
  const order = query.direction === "asc" ? asc : desc;
  // 先排序再分頁；相同值用固定 ID 決勝，避免翻頁時重複或漏列。
  const images = await db.select().from(mediaCdnImages).where(filters).orderBy(order(columns[query.sort ?? "updatedAt"]), desc(mediaCdnImages.id)).limit(24).offset((query.page - 1) * 24);
  return { images, total: total?.count ?? 0, page: query.page, pageSize: 24 };
}

export async function replaceMediaCdnImage(db: Database, id: string, revision: number, file: MediaCdnFileInput) {
  const [image] = await db.update(mediaCdnImages).set({ ...file, revision: revision + 1, updatedAt: toDbTimestamp(), purgePending: true, purgeError: null })
    .where(and(eq(mediaCdnImages.id, id), eq(mediaCdnImages.revision, revision), isNull(mediaCdnImages.deletedAt))).returning();
  return image ?? null;
}

export async function renameMediaCdnImage(db: Database, id: string, revision: number, name: string) {
  const [image] = await db.update(mediaCdnImages).set({ name, revision: revision + 1, updatedAt: toDbTimestamp(), purgePending: true })
    .where(and(eq(mediaCdnImages.id, id), eq(mediaCdnImages.revision, revision), isNull(mediaCdnImages.deletedAt))).returning();
  return image ?? null;
}

export async function deleteMediaCdnImage(db: Database, id: string, revision: number) {
  const now = toDbTimestamp();
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

export async function listUnusedMediaCdnBlobs(db: Database, before = toDbTimestamp(Date.now() - 86_400_000)) {
  return db.select().from(mediaCdnBlobs).where(and(lte(julian(mediaCdnBlobs.createdAt), julian(before)), notInArray(mediaCdnBlobs.objectKey,
    db.select({ key: mediaCdnImages.objectKey }).from(mediaCdnImages).where(isNotNull(mediaCdnImages.objectKey)),
  ))).limit(100);
}

export async function forgetMediaCdnBlob(db: Database, objectKey: string) {
  await db.delete(mediaCdnBlobs).where(eq(mediaCdnBlobs.objectKey, objectKey));
}
