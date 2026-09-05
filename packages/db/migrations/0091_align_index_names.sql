-- 這一支是「對帳」，不是新的 schema 變更。
--
-- #180 手寫 0074–0089 時給索引取的名字，跟 schema/*.ts 宣告的名字對不上，而
-- drizzle 的 snapshot 又漏掉沒補，於是兩邊各說各話：`pnpm generate` 以為正式庫
-- 叫 A，正式庫其實叫 B。不對回來的話，之後每一支自動產生的 migration 都會去
-- DROP 一個不存在的索引。
--
-- 每一句都寫 IF EXISTS／IF NOT EXISTS：正式庫與「從 migration 從頭建起來的資料庫」
-- 現在處在不同狀態，同一支 migration 必須在兩邊都跑得過。

-- 1. 欄位上的 .unique() 讓 drizzle 自動取名 <表>_<欄>_unique，正式庫則是 0076
--    手寫的 idx_*。schema 已經改成具名索引，這裡把自動名清掉。
DROP INDEX IF EXISTS `wms_categories_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_wms_categories_name` ON `wms_categories` (`name`);--> statement-breakpoint
DROP INDEX IF EXISTS `wms_zones_code_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_wms_zones_code` ON `wms_zones` (`code`);--> statement-breakpoint
DROP INDEX IF EXISTS `wms_layouts_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_wms_layouts_name` ON `wms_layouts` (`name`);--> statement-breakpoint
DROP INDEX IF EXISTS `wms_cyberbiz_links_wms_item_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_wms_cyberbiz_links_item` ON `wms_cyberbiz_links` (`wms_item_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `wms_cyberbiz_links_cyberbiz_variant_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_wms_cyberbiz_links_variant` ON `wms_cyberbiz_links` (`cyberbiz_variant_id`);--> statement-breakpoint

-- 2. 名字還停在改名前的表名：customer_tag_catalog 已經是 crm_tags，
--    cyberbiz_customer_webhooks 已經是 cyberbiz_webhook_events。
DROP INDEX IF EXISTS `idx_customer_tag_catalog_name`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_crm_tags_name` ON `crm_tags` (`name`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_cyberbiz_customer_webhooks_status`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_status` ON `cyberbiz_webhook_events` (`status`,`received_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_payout_target_date`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_payout_daily_date` ON `report_payout_daily_target` (`business_date`,`scope_id`);--> statement-breakpoint

-- 3. schema 宣告了但正式庫從來沒建起來的兩支。
--    id 是主鍵，所以 (id, depth) 一定唯一，補這支不會失敗；item_categories 的
--    兩層樹是靠複合外鍵指向它，沒有它那個外鍵根本立不起來。
CREATE UNIQUE INDEX IF NOT EXISTS `idx_item_categories_id_depth` ON `item_categories` (`id`,`depth`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_entity` ON `cyberbiz_webhook_events` (`entity_type`,`external_entity_id`,`received_at`);
--> statement-breakpoint

-- 4. cyberbiz_products.item_id 本來就是主鍵，PK 的 autoindex 已經涵蓋它，
--    這支索引是重複的。
DROP INDEX IF EXISTS `idx_cyberbiz_products_item`;
