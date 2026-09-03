import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const isoNow = () => new Date().toISOString();

/**
 * 物件儲存的 metadata。
 *
 * 圖片 bytes 留在 NAS 或既有 object storage，D1 只保存查詢、授權與清理需要的短資料。
 * objectKey 是 gateway 產生的唯一鍵，不接受前端自行指定路徑。
 */
export const mediaObjects = sqliteTable("media_objects", {
  objectKey: text("object_key").primaryKey(),
  namespace: text("namespace").notNull(),
  scopeKey: text("scope_key").notNull().default(""),
  filename: text("filename").notNull().default(""),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  checksum: text("checksum").notNull(),
  storageProvider: text("storage_provider").notNull().default("nas"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`).$defaultFn(isoNow),
  expiresAt: text("expires_at"),
}, (table) => [
  index("idx_media_objects_expires_at").on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
]);

export type MediaObject = typeof mediaObjects.$inferSelect;
