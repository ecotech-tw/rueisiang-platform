-- 先只拍子表 snapshot。parent 的 snapshot 與重建拆到下一支，避免單支
-- migration 同時複製三張表並重建索引而超過 D1 CPU 預算。
INSERT INTO `_crm_customer_tags_backup`
  SELECT * FROM `crm_customer_tags`;--> statement-breakpoint
INSERT INTO `_webhook_customer_backup` (`id`, `customer_id`)
  SELECT `id`, `customer_id`
  FROM `cyberbiz_webhook_events`
  WHERE `customer_id` IS NOT NULL;
