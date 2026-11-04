import { createMediaCdnImage, deleteMediaCdnImage, findMediaCdnImage, listMediaCdnImages, registerMediaCdnBlob, renameMediaCdnImage, replaceMediaCdnImage } from "@rueisiang/db";
import { MEDIA_IMAGE_MAX_BYTES, MEDIA_IMAGE_MAX_PIXELS, MEDIA_IMAGE_MAX_SIDE, MEDIA_IMAGE_TYPES, isMediaImageSortField } from "@rueisiang/db/media-cdn-fields";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { validateRasterImage } from "../image-validation.js";
import { mediaCdnConfig, mediaCdnView, purgeMediaCdnImage, requireMediaCdnStorage } from "../media-cdn.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

function revision(value: unknown) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) throw new HTTPException(400, { message: "請提供有效的圖片版本。" });
  return number;
}
function imageName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new HTTPException(400, { message: "圖片名稱需為 1–120 個字。" });
  return value.trim();
}
function conflict<T>(value: T | null): T {
  if (!value) throw new HTTPException(409, { message: "圖片已被其他同仁更新或刪除，請重新整理後再操作。" });
  return value;
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const input: unknown = await request.json().catch(() => { throw new HTTPException(400, { message: "請提供有效的 JSON 內容。" }); });
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HTTPException(400, { message: "請提供有效的 JSON 物件。" });
  return input as Record<string, unknown>;
}
async function readForm(request: Request) {
  return request.formData().catch(() => { throw new HTTPException(400, { message: "圖片上傳格式無效。" }); });
}

export const media = new Hono<AppEnv>();
media.use("*", requireAuth);
media.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });

media.get("/images", requirePermission("media:image:read"), async (c) => {
  const type = c.req.query("type");
  if (type && !MEDIA_IMAGE_TYPES.some((value) => value === type)) throw new HTTPException(400, { message: "不支援的圖片格式。" });
  const page = Number(c.req.query("page") || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new HTTPException(400, { message: "頁碼無效。" });
  const sort = c.req.query("sort") ?? "updatedAt";
  const direction = c.req.query("direction") ?? "desc";
  if (!isMediaImageSortField(sort) || (direction !== "asc" && direction !== "desc")) throw new HTTPException(400, { message: "不支援的圖片排序方式。" });
  const result = await listMediaCdnImages(c.get("db"), { search: c.req.query("search"), type, page, deleted: c.req.query("deleted") === "true", sort, direction });
  let configured = false;
  try { requireMediaCdnStorage(c.env); configured = true; } catch { /* 管理頁仍可顯示設定提醒。 */ }
  const config = mediaCdnConfig(c.env);
  return c.json({ ...result, images: result.images.map((image) => mediaCdnView(c.env, image)), configured, local: config.local, cdnOrigin: config.origin });
});

media.get("/images/:id/preview", requirePermission("media:image:read"), async (c) => {
  const image = await findMediaCdnImage(c.get("db"), c.req.param("id"));
  if (!image || image.deletedAt || !image.objectKey) throw new HTTPException(404, { message: "圖片不存在。" });
  if (!c.env.MEDIA) throw new HTTPException(503, { message: "尚未設定 media 儲存空間。" });
  const object = await c.env.MEDIA.get(image.objectKey);
  if (!object) throw new HTTPException(404, { message: "圖片檔案不存在。" });
  return c.body(object.body, 200, { "Content-Type": image.contentType, "X-Content-Type-Options": "nosniff" });
});

const uploadLimit = bodyLimit({ maxSize: MEDIA_IMAGE_MAX_BYTES + 64 * 1024, onError: () => { throw new HTTPException(413, { message: "每張圖片最多 10 MB。" }); } });

async function readFile(form: FormData) {
  const file: unknown = form.get("file");
  if (!(file instanceof File)) throw new HTTPException(400, { message: "請選擇圖片檔案。" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await validateRasterImage(bytes, file.type, { maxInputBytes: MEDIA_IMAGE_MAX_BYTES, maxPixels: MEDIA_IMAGE_MAX_PIXELS, maxSide: MEDIA_IMAGE_MAX_SIDE });
  return { bytes, metadata, filename: file.name.slice(0, 255) };
}

media.post("/images", requirePermission("media:image:write"), uploadLimit, async (c) => {
  const bucket = requireMediaCdnStorage(c.env);
  const form = await readForm(c.req.raw);
  const { bytes, metadata, filename } = await readFile(form);
  const name = imageName(form.get("name") || filename);
  const id = crypto.randomUUID();
  const objectKey = `cdn/${id}/${crypto.randomUUID()}`;
  const db = c.get("db");
  await registerMediaCdnBlob(db, objectKey);
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: metadata.contentType } });
  const image = await createMediaCdnImage(db, { id, name, filename, objectKey, ...metadata, size: bytes.length, createdBy: c.get("user").id });
  const result = await purgeMediaCdnImage(c.env, db, image);
  return c.json({ image: mediaCdnView(c.env, result) }, 201);
});

media.put("/images/:id", requirePermission("media:image:write"), uploadLimit, async (c) => {
  const bucket = requireMediaCdnStorage(c.env);
  const form = await readForm(c.req.raw);
  const version = revision(form.get("revision"));
  const db = c.get("db");
  const previous = await findMediaCdnImage(db, c.req.param("id"));
  if (!previous || previous.deletedAt) throw new HTTPException(404, { message: "圖片不存在。" });
  if (previous.revision !== version) conflict(null);
  const { bytes, metadata, filename } = await readFile(form);
  const objectKey = `cdn/${previous.id}/${crypto.randomUUID()}`;
  await registerMediaCdnBlob(db, objectKey);
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: metadata.contentType } });
  const image = conflict(await replaceMediaCdnImage(db, previous.id, version, { objectKey, ...metadata, filename, size: bytes.length }));
  return c.json({ image: mediaCdnView(c.env, await purgeMediaCdnImage(c.env, db, image)) });
});

const jsonLimit = bodyLimit({ maxSize: 16 * 1024, onError: () => { throw new HTTPException(413, { message: "圖片管理請求過大。" }); } });

media.patch("/images/:id", requirePermission("media:image:write"), jsonLimit, async (c) => {
  requireMediaCdnStorage(c.env);
  const input = await readObject(c.req.raw);
  const image = conflict(await renameMediaCdnImage(c.get("db"), c.req.param("id"), revision(input.revision), imageName(input.name)));
  return c.json({ image: mediaCdnView(c.env, await purgeMediaCdnImage(c.env, c.get("db"), image)) });
});

media.delete("/images/:id", requirePermission("media:image:delete"), jsonLimit, async (c) => {
  requireMediaCdnStorage(c.env);
  const input = await readObject(c.req.raw);
  if (input.confirmedUnused !== true) throw new HTTPException(400, { message: "請先確認官網及其他頁面已不再使用此連結。" });
  const image = conflict(await deleteMediaCdnImage(c.get("db"), c.req.param("id"), revision(input.revision)));
  return c.json({ image: mediaCdnView(c.env, await purgeMediaCdnImage(c.env, c.get("db"), image)) });
});

media.post("/images/:id/purge", requirePermission("media:image:write"), async (c) => {
  requireMediaCdnStorage(c.env);
  const image = await findMediaCdnImage(c.get("db"), c.req.param("id"));
  if (!image) throw new HTTPException(404, { message: "圖片不存在。" });
  return c.json({ image: mediaCdnView(c.env, await purgeMediaCdnImage(c.env, c.get("db"), image)) });
});
