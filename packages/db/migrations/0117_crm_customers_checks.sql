-- D1 的單次查詢與 CPU 預算有限，不能把整張客戶表、標籤關聯與 webhook
-- 對應在同一支 migration 裡備份、重建、回填。先把備份獨立出來；後續 migration
-- 即使中途失敗也能從這些備份重試，不會把正式資料當成可丟棄的暫存資料。
CREATE TABLE `_crm_customers_backup` AS SELECT * FROM `crm_customers`;--> statement-breakpoint
CREATE TABLE `_crm_customer_tags_backup` AS SELECT * FROM `crm_customer_tags`;--> statement-breakpoint

-- CTAS 不會替 id 建索引；下一支會用這個表把 webhook 的 customer_id 寫回去，
-- 主鍵避免逐列回填時對 2,457 筆備份做全表掃描。
CREATE TABLE `_webhook_customer_backup` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL
);--> statement-breakpoint
INSERT INTO `_webhook_customer_backup` (`id`, `customer_id`)
  SELECT `id`, `customer_id`
  FROM `cyberbiz_webhook_events`
  WHERE `customer_id` IS NOT NULL;
