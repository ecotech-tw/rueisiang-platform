-- crm_customers 的 CHECK 只能透過重建表加入。先前 migration 已完成備份，這裡只做
-- parent table 的替換與回填；標籤和 webhook 的子表留到後面的 migration，避免單次
-- D1 查詢超過 CPU 預算。
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
  WHERE `name` = '' OR `address` = '';
