import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 公開圖片有固定網址、版本與刪除後的 purge 狀態，不能套用私有 NAS 的到期清理流程。
export const mediaCdnImages = sqliteTable("media_cdn_images", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  filename: text("filename").notNull(),
  objectKey: text("object_key"),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  revision: integer("revision").notNull().default(1),
  purgePending: integer("purge_pending", { mode: "boolean" }).notNull().default(true),
  purgeError: text("purge_error"),
  deletedAt: text("deleted_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_media_cdn_images_updated").on(table.updatedAt),
  index("idx_media_cdn_images_purge").on(table.purgePending).where(sql`${table.purgePending} = 1`),
]);

// 上傳前先登記；即使 R2 寫入或 D1 切換回應遺失，未被引用的版本仍有可重試的清理入口。
export const mediaCdnBlobs = sqliteTable("media_cdn_blobs", {
  objectKey: text("object_key").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export type MediaCdnImage = typeof mediaCdnImages.$inferSelect;
