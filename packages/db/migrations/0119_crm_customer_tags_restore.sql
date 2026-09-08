-- DROP parent table 會依 ON DELETE CASCADE 清掉 crm_customer_tags；從第一支 migration
-- 的備份還原，不能只依賴本機 SQLite 的 foreign_keys 行為來猜正式 D1 的結果。
DELETE FROM `crm_customer_tags`;--> statement-breakpoint
INSERT INTO `crm_customer_tags` SELECT * FROM `_crm_customer_tags_backup`;
