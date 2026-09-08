CREATE INDEX `idx_crm_customers_updated`
  ON `crm_customers` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_cb_updated`
  ON `crm_customers` (`cyberbiz_updated_at`);--> statement-breakpoint
CREATE INDEX `idx_crm_customers_incomplete`
  ON `crm_customers` (`id`)
  WHERE `name` = '' OR `address` = '';
