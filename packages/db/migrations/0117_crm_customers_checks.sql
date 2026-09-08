-- 先建立跨 transaction 會用到的備份表。資料刻意留到下一支 migration 才拍，讓
-- parent 重建前的 customer、tag 與 webhook snapshot 來自同一個 transaction。
CREATE TABLE `_crm_customer_tags_backup` AS
  SELECT * FROM `crm_customer_tags` WHERE 0;--> statement-breakpoint
CREATE TABLE `_webhook_customer_backup` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL
);--> statement-breakpoint
