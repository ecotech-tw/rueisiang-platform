import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { items } from "./items.js";

export type OrderRestockMode = "observe" | "apply";
export type OrderRestockState = "pending" | "checking" | "applying" | "applied" | "unchanged" | "observed" | "skipped" | "review";

/** 業務防重帳本不跟 webhook 的 30 天留存一起清除；遠端寫入結果不明時禁止再次送差額。 */
export const cyberbizOrderRestocks = sqliteTable("cyberbiz_order_restocks", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  phase: text("phase").$type<"create" | "cancel">().notNull(),
  source: text("source").notNull(),
  productId: text("product_id").notNull().default(""),
  variantId: text("variant_id").notNull().default(""),
  sku: text("sku").notNull().default(""),
  quantity: integer("quantity").notNull().default(0),
  itemId: text("item_id").references(() => items.id, { onDelete: "set null" }),
  mode: text("mode").$type<OrderRestockMode>().notNull(),
  state: text("state").$type<OrderRestockState>().notNull().default("pending"),
  orderCreatedAt: text("order_created_at").notNull().default(""),
  targetQuantity: integer("target_quantity"),
  remoteBefore: integer("remote_before"),
  remoteAfter: integer("remote_after"),
  attempts: integer("attempts").notNull().default(0),
  reason: text("reason").notNull().default(""),
  startedAt: text("started_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_order_restocks_business_key").on(table.orderId, table.phase, table.variantId),
  index("idx_order_restocks_pending").on(table.mode, table.state, table.createdAt),
  index("idx_order_restocks_item").on(table.itemId, table.state),
  check("ck_order_restocks_phase", sql`${table.phase} IN ('create', 'cancel')`),
  check("ck_order_restocks_mode", sql`${table.mode} IN ('observe', 'apply')`),
  check("ck_order_restocks_state", sql`${table.state} IN ('pending', 'checking', 'applying', 'applied', 'unchanged', 'observed', 'skipped', 'review')`),
  check("ck_order_restocks_quantity", sql`${table.quantity} >= 0`),
]);

export type CyberbizOrderRestock = typeof cyberbizOrderRestocks.$inferSelect;
