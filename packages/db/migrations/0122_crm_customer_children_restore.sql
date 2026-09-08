-- parent 重建時，crm_customer_tags 會因 ON DELETE CASCADE 被清空。不要先 DELETE：
-- 中間 transaction 期間可能已寫入新關聯，INSERT OR IGNORE 才不會把它們刪掉。
INSERT OR IGNORE INTO `crm_customer_tags`
  SELECT * FROM `_crm_customer_tags_backup`;--> statement-breakpoint

-- webhook 的 customer_id 是 ON DELETE SET NULL。只補真正被清空的列，保留中間
-- transaction 期間由 Worker 新寫入或修改的關聯。
UPDATE `cyberbiz_webhook_events`
SET `customer_id` = (
  SELECT `customer_id`
  FROM `_webhook_customer_backup`
  WHERE `_webhook_customer_backup`.`id` = `cyberbiz_webhook_events`.`id`
)
WHERE `customer_id` IS NULL
  AND `id` IN (SELECT `id` FROM `_webhook_customer_backup`);--> statement-breakpoint

DROP TABLE `_crm_customers_backup`;--> statement-breakpoint
DROP TABLE `_crm_customer_tags_backup`;--> statement-breakpoint
DROP TABLE `_webhook_customer_backup`;
