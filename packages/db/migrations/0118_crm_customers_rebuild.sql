-- 這支 transaction 先拍同一個時間點的 customer、tag、webhook 資料，再重建 parent。
-- 子表的還原放到下一支，讓最重的單次操作不超過 D1 CPU 預算；備份表在中間
-- transaction 之間保留，失敗時可安全重試。
CREATE TABLE `_crm_customers_backup` AS SELECT * FROM `crm_customers`;--> statement-breakpoint
INSERT INTO `_crm_customer_tags_backup`
  SELECT * FROM `crm_customer_tags`;--> statement-breakpoint
INSERT INTO `_webhook_customer_backup` (`id`, `customer_id`)
  SELECT `id`, `customer_id`
  FROM `cyberbiz_webhook_events`
  WHERE `customer_id` IS NOT NULL;--> statement-breakpoint

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
  FROM `_crm_customers_backup`;--> statement-breakpoint

-- 先回填資料再建索引，避免每一列 INSERT 都同時維護六支索引。
CREATE UNIQUE INDEX `idx_crm_customers_cyberbiz_customer_id`
  ON `crm_customers` (`cyberbiz_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_phone`
  ON `crm_customers` (`normalized_phone`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_status`
  ON `crm_customers` (`status`, `updated_at`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_updated`
  ON `crm_customers` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_cb_updated`
  ON `crm_customers` (`cyberbiz_updated_at`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_incomplete`
  ON `crm_customers` (`id`)
  WHERE `name` = '' OR `address` = '';--> statement-breakpoint

DROP TABLE `_crm_customers_backup`;
