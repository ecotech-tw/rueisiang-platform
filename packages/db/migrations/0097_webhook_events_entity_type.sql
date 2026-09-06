-- docs/platform-schema-target.sql 設計的 cyberbiz_webhook_events 是「兩張併一張」：
-- 會員與商品的 webhook 進同一張表，用 entity_type 分。0075 只做了加欄位——
-- entity_type、external_entity_id 這兩欄在正式庫 4,288 列全部是 NULL，程式裡
-- 一個 consumer 都沒有，商品事件到現在還是走 cyberbiz_product_webhooks（587 列）。
--
-- 合併本身要動到還在線上的商品 webhook 接收路徑，那是另一件事。這一支只做
-- 「讓欄位不再說謊」：既有的列全部是會員事件，回填成 'customer'，之後寫入時
-- 一律帶值，再把兩條 CHECK 補上。做完之後這一欄是可信的，商品那邊要併進來時
-- 只要開始寫 'product' 就好。
--
-- 順便把 attempts 的預設改成 1（設計如此：收到就是第一次嘗試）。現有的 0 不動，
-- 那是 0075 建欄位時填的，改它沒有意義。
--
-- 重建整張表是因為 SQLite 加不了 CHECK。這張表沒有任何子表指著它，
-- 所以不必像 0092／0093 那樣先存後補——DROP 不會連坐到任何東西。

CREATE TABLE `__new_cyberbiz_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`cyberbiz_customer_id` text,
	`customer_id` text,
	`payload_json` text NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`entity_type` text DEFAULT 'customer' NOT NULL,
	`external_entity_id` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `crm_customers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_webhook_events_entity" CHECK("__new_cyberbiz_webhook_events"."entity_type" IN ('customer', 'product')),
	CONSTRAINT "ck_webhook_events_status" CHECK("__new_cyberbiz_webhook_events"."status" IN ('processing', 'processed', 'ignored', 'failed'))
);--> statement-breakpoint

-- external_entity_id 的語意是「商品放 variant_id、會員放 cyberbiz_customer_id」，
-- 既有的列都是會員事件，所以直接沿用那一欄。
INSERT INTO `__new_cyberbiz_webhook_events`
  (`id`, `topic`, `status`, `cyberbiz_customer_id`, `customer_id`, `payload_json`, `result_json`,
   `last_error`, `received_at`, `processed_at`, `updated_at`, `entity_type`, `external_entity_id`, `attempts`)
  SELECT `id`, `topic`, `status`, `cyberbiz_customer_id`, `customer_id`, `payload_json`, `result_json`,
   `last_error`, `received_at`, `processed_at`, `updated_at`,
   'customer', COALESCE(`external_entity_id`, `cyberbiz_customer_id`), `attempts`
  FROM `cyberbiz_webhook_events`;--> statement-breakpoint

DROP TABLE `cyberbiz_webhook_events`;--> statement-breakpoint
ALTER TABLE `__new_cyberbiz_webhook_events` RENAME TO `cyberbiz_webhook_events`;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_webhook_events_status` ON `cyberbiz_webhook_events` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_customer` ON `cyberbiz_webhook_events` (`cyberbiz_customer_id`,`received_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_entity` ON `cyberbiz_webhook_events` (`entity_type`,`external_entity_id`,`received_at`);
