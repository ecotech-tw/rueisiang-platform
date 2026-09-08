-- cyberbiz_webhook_events 的外鍵是 ON DELETE SET NULL；重建 parent 時先被清空的
-- customer_id 從有主鍵的備份表寫回，避免相關 webhook 失去客戶關聯。
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
