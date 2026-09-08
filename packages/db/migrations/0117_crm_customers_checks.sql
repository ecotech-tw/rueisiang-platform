-- docs/platform-schema-target.sql 的 crm_customers 有兩條 CHECK，正式庫一條都沒有：
--   CHECK (status      IN ('active','blocked'))
--   CHECK (sync_status IN ('synced','failed'))
--
-- 這兩欄都是控制流程用的，不是拿來顯示的。status 決定客戶出現在「正常」還是
-- 「封鎖」清單，sync_status 決定補跑撈不撈得到它。塞進值域外的字串不會報錯，
-- 只會讓那一列對所有 WHERE 都隱形——這種問題通常幾個月後才有人發現。
--
-- 順手修掉一個現成的地雷：sync_status 的預設值是 'local_only'，但值域裡沒有
-- 這個狀態（schema.ts 寫的是 'synced'，程式裡 8 處寫入也全部寫 'synced'）。
-- 只要有一筆 insert 沒帶 sync_status，它就會拿到一個補跑不認得的值而永遠卡住。
-- 現有 11,061 列全部是 'synced'，改預設不影響既有資料。
--
-- ⚠️ 為什麼要先存後補：這張表有兩個子表，而 D1 的 migration 包在一個 transaction
--    裡、PRAGMA foreign_keys 在裡面是 no-op，所以 DROP TABLE 會連坐：
--      crm_customer_tags.customer_id        CASCADE   11,363 列會被刪光
--      cyberbiz_webhook_events.customer_id  SET NULL   2,457 筆會被清成 NULL
--    照 drizzle 產的重建 SQL 走就是這個下場（0023 的教訓）。

CREATE TABLE `_crm_customers_backup` AS SELECT * FROM `crm_customers`;--> statement-breakpoint
CREATE TABLE `_crm_customer_tags_backup` AS SELECT * FROM `crm_customer_tags`;--> statement-breakpoint
CREATE TABLE `_webhook_customer_backup` AS
  SELECT `id`, `customer_id` FROM `cyberbiz_webhook_events` WHERE `customer_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `crm_customers`;--> statement-breakpoint

CREATE TABLE `crm_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`normalized_phone` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cyberbiz_customer_id` text,
	`cyberbiz_uid` text,
	`cyberbiz_updated_at` text,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	`synced_at` text,
	`blocked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ck_crm_customers_status" CHECK("crm_customers"."status" IN ('active', 'blocked')),
	CONSTRAINT "ck_crm_customers_sync_status" CHECK("crm_customers"."sync_status" IN ('synced', 'failed'))
);--> statement-breakpoint

-- 索引跟著表一起被刪掉了，六支都要補回來。
CREATE UNIQUE INDEX IF NOT EXISTS `idx_crm_customers_cyberbiz_customer_id` ON `crm_customers` (`cyberbiz_customer_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_phone` ON `crm_customers` (`normalized_phone`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_status` ON `crm_customers` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_updated` ON `crm_customers` (`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_cb_updated` ON `crm_customers` (`cyberbiz_updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_incomplete` ON `crm_customers` (`id`) WHERE `name` = '' OR `address` = '';--> statement-breakpoint

INSERT INTO `crm_customers`
  (`id`, `phone`, `normalized_phone`, `name`, `email`, `address`, `status`,
   `cyberbiz_customer_id`, `cyberbiz_uid`, `cyberbiz_updated_at`, `raw_json`,
   `sync_status`, `synced_at`, `blocked_at`, `created_at`, `updated_at`)
  SELECT `id`, `phone`, `normalized_phone`, `name`, `email`, `address`, `status`,
   `cyberbiz_customer_id`, `cyberbiz_uid`, `cyberbiz_updated_at`, `raw_json`,
   `sync_status`, `synced_at`, `blocked_at`, `created_at`, `updated_at`
  FROM `_crm_customers_backup`;--> statement-breakpoint

-- 標籤關聯照備份還原。先清空再塞回去，不去猜 DROP TABLE 的隱含 DELETE 連坐到哪裡——
-- 猜錯的那一邊不是少資料就是主鍵撞車。備份是幾行之前才拍的，它就是唯一的事實。
DELETE FROM `crm_customer_tags`;--> statement-breakpoint
INSERT INTO `crm_customer_tags` SELECT * FROM `_crm_customer_tags_backup`;--> statement-breakpoint

-- webhook 的 customer_id 是 SET NULL，被清掉的照對應表寫回去。
UPDATE `cyberbiz_webhook_events` SET `customer_id` = (
  SELECT `customer_id` FROM `_webhook_customer_backup` WHERE `id` = `cyberbiz_webhook_events`.`id`
) WHERE `id` IN (SELECT `id` FROM `_webhook_customer_backup`);--> statement-breakpoint

DROP TABLE `_crm_customers_backup`;--> statement-breakpoint
DROP TABLE `_crm_customer_tags_backup`;--> statement-breakpoint
DROP TABLE `_webhook_customer_backup`;
