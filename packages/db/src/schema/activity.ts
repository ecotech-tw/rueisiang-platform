import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 全系統共用的操作紀錄。
 *
 * 原本是 CRM 專用的 `customer_events`。WMS 搬進來時帶著自己的 `audit_logs`
 * （欄位級的變更紀錄），兩張表回答的是同一個問題——「這筆資料什麼時候被誰改了
 * 什麼」——差別只在一個記整包 payload、一個記單一欄位的新舊值。
 *
 * 留兩張的話，「操作紀錄」這一頁就得同時查兩處再自己排序合併，而且之後每多一個
 * 模組就多一張表。合成一張，代價是欄位比較寬（CRM 用不到 field/oldValue，
 * WMS 用不到 payloadJson），但那比兩套讀取邏輯便宜。
 */
export const activityEvents = sqliteTable("activity_events", {
  id: text("id").primaryKey(),

  /**
   * 這筆紀錄講的是哪一種東西：customer、zone、inventory_item、product_category…
   *
   * 刻意不做成 enum 或外鍵：新模組搬進來時只要開始寫自己的 entityType 就好，
   * 不必先改 schema。代價是打錯字不會被擋下來，所以寫入端統一走
   * `recordActivity()`，型別在那裡把關。
   */
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),

  /**
   * 當下那個東西叫什麼（客戶姓名、倉位代號、品項名稱）。
   *
   * 存快照而不是靠 join：東西被刪掉之後紀錄還要看得懂。原本的 customer_events
   * 是 innerJoin customers，客戶一刪，他的操作紀錄就跟著從畫面上消失了。
   */
  entityLabel: text("entity_label").notNull().default(""),

  /** 做了什麼：created、updated、blocked、synced、deleted… */
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),

  /*
   * 欄位級的變更。WMS 的紀錄以此為主（「最低庫存 5 → 10」），CRM 留空——
   * 它記的是整包 payload，拆到欄位反而失去脈絡。
   */
  field: text("field").notNull().default(""),
  oldValue: text("old_value"),
  newValue: text("new_value"),

  /** CRM 的完整內容（同步回應、webhook payload）。WMS 留 {}。 */
  payloadJson: text("payload_json").notNull().default("{}"),

  // user：有人操作／system：排程或同步自己做的
  actorType: text("actor_type").notNull().default("system"),
  actorId: text("actor_id"),
  /** email 存快照，帳號被刪之後仍然看得出當初是誰做的。 */
  actorEmail: text("actor_email"),

  /** 哪個模組寫的：crm、wms、cyberbiz（官網同步過來的）。 */
  source: text("source").notNull().default("crm"),
  status: text("status").notNull().default("succeeded"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // 「這個東西的歷程」是最常見的查詢，兩個欄位一起才有意義。
  index("idx_activity_entity_created").on(table.entityType, table.entityId, table.createdAt),
  index("idx_activity_source_created").on(table.source, table.createdAt),
  index("idx_activity_actor_created").on(table.actorId, table.createdAt),
  // 整頁不帶條件時就是照時間倒序，需要單獨一支索引。
  index("idx_activity_created").on(table.createdAt),
]);

export type ActivityEvent = typeof activityEvents.$inferSelect;
