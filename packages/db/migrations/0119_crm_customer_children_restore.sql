-- 在同一個 transaction 內 snapshot customer 並重建 parent。子表 backup 已由
-- 0118 完成，還原留到後續 migration，讓每支 migration 的 CPU 負載更小。
--
-- 兩支 child table 原本沒有 customer_id index。SQLite 在 DROP parent 時執行
-- ON DELETE CASCADE / SET NULL，沒有這兩支 index 會對每個 customer 掃 child table，
-- 正式 D1 會因此超過 CPU 預算。
CREATE INDEX IF NOT EXISTS `idx_crm_customer_tags_customer`
  ON `crm_customer_tags` (`customer_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_customer_id`
  ON `cyberbiz_webhook_events` (`customer_id`);--> statement-breakpoint

CREATE TABLE `_crm_customers_backup` AS SELECT * FROM `crm_customers`;--> statement-breakpoint

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

INSERT INTO `crm_customers`
  (`id`, `phone`, `normalized_phone`, `name`, `email`, `address`, `status`,
   `cyberbiz_customer_id`, `cyberbiz_uid`, `cyberbiz_updated_at`, `raw_json`,
   `sync_status`, `synced_at`, `blocked_at`, `created_at`, `updated_at`)
  SELECT `id`, `phone`, `normalized_phone`, `name`, `email`, `address`, `status`,
   `cyberbiz_customer_id`, `cyberbiz_uid`, `cyberbiz_updated_at`, `raw_json`,
   `sync_status`, `synced_at`, `blocked_at`, `created_at`, `updated_at`
  FROM `_crm_customers_backup`;
