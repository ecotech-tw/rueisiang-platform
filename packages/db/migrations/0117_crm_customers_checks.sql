-- 這支 migration 必須把 parent 與兩個子表的重建放在同一個 D1 transaction：deploy 時舊 Worker
-- 仍可能收到請求，拆成多支 migration 會讓中間狀態的寫入被後續還原覆蓋。
-- 透過 webhook 備份的主鍵，以及回填資料後才建索引，降低原本超過 D1 CPU 預算的查詢成本。
CREATE TABLE `_crm_customers_backup` AS SELECT * FROM `crm_customers`;--> statement-breakpoint
CREATE TABLE `_crm_customer_tags_backup` AS SELECT * FROM `crm_customer_tags`;--> statement-breakpoint
CREATE TABLE `_webhook_customer_backup` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL
);--> statement-breakpoint
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

-- DROP parent table 會依 ON DELETE CASCADE 清掉 crm_customer_tags；照備份還原，不能猜
-- DROP TABLE 的隱含 DELETE 連坐到哪裡。備份在同一 transaction 內才不會被中間寫入污染。
DELETE FROM `crm_customer_tags`;--> statement-breakpoint
INSERT INTO `crm_customer_tags` SELECT * FROM `_crm_customer_tags_backup`;--> statement-breakpoint

-- cyberbiz_webhook_events 的外鍵是 ON DELETE SET NULL；用有主鍵的備份表回填，避免
-- 原本的相關子查詢對每筆 webhook 掃描整張備份表。
UPDATE `cyberbiz_webhook_events`
SET `customer_id` = (
  SELECT `customer_id`
  FROM `_webhook_customer_backup`
  WHERE `_webhook_customer_backup`.`id` = `cyberbiz_webhook_events`.`id`
)
WHERE `id` IN (SELECT `id` FROM `_webhook_customer_backup`);--> statement-breakpoint

DROP TABLE `_crm_customers_backup`;--> statement-breakpoint
DROP TABLE `_crm_customer_tags_backup`;--> statement-breakpoint
DROP TABLE `_webhook_customer_backup`;
