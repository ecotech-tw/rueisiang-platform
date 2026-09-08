-- 分批建立 parent 索引，避免索引重建本身超過單支 migration 的 D1 CPU 預算。
CREATE UNIQUE INDEX `idx_crm_customers_cyberbiz_customer_id`
  ON `crm_customers` (`cyberbiz_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_phone`
  ON `crm_customers` (`normalized_phone`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_status`
  ON `crm_customers` (`status`, `updated_at`);
