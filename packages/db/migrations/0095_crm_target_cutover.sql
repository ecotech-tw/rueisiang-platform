/* CRM target cutover: relation-based tags and no second source-channel/sync state. */

/* Keep every tag that was attached to a customer, including tags missing from the old catalog. */
INSERT OR IGNORE INTO `crm_tags` (`id`, `name`, `created_at`, `updated_at`)
SELECT
  'crm-tag:' || lower(hex(randomblob(16))),
  trim(json_each.value),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM `crm_customers`, json_each(
  CASE
    WHEN json_valid(`crm_customers`.`cyberbiz_tags_json`) THEN `crm_customers`.`cyberbiz_tags_json`
    ELSE '[]'
  END
)
WHERE typeof(json_each.value) = 'text'
  AND trim(json_each.value) <> '';
--> statement-breakpoint

INSERT OR IGNORE INTO `crm_customer_tags` (`customer_id`, `crm_tag_id`)
SELECT DISTINCT customer.id, tag.id
FROM `crm_customers` AS customer, json_each(
  CASE
    WHEN json_valid(customer.`cyberbiz_tags_json`) THEN customer.`cyberbiz_tags_json`
    ELSE '[]'
  END
)
JOIN `crm_tags` AS tag ON tag.`name` = trim(json_each.value)
WHERE typeof(json_each.value) = 'text'
  AND trim(json_each.value) <> '';
--> statement-breakpoint

/* Historical local-only rows are retained as customers; the target status is synced/failed. */
UPDATE `crm_customers`
SET `sync_status` = 'synced'
WHERE `sync_status` = 'local_only';
--> statement-breakpoint

/* The compatibility view must be gone before the physical customer columns change. */
DROP VIEW IF EXISTS `customers`;
--> statement-breakpoint

DROP INDEX IF EXISTS `idx_customers_cyberbiz_customer_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_customers_normalized_phone`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_customers_status_channel`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_customers_updated_at`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_customers_cyberbiz_updated_at`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_customers_incomplete`;
--> statement-breakpoint

ALTER TABLE `crm_customers` DROP COLUMN `source_channel`;
--> statement-breakpoint
ALTER TABLE `crm_customers` DROP COLUMN `cyberbiz_tags_json`;
--> statement-breakpoint
ALTER TABLE `crm_customers` DROP COLUMN `sync_error`;
--> statement-breakpoint
ALTER TABLE `crm_customers` DROP COLUMN `last_webhook_at`;
--> statement-breakpoint
ALTER TABLE `crm_saved_views` DROP COLUMN `channel`;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `idx_crm_customers_cyberbiz_customer_id`
  ON `crm_customers` (`cyberbiz_customer_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_phone`
  ON `crm_customers` (`normalized_phone`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_status`
  ON `crm_customers` (`status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_updated`
  ON `crm_customers` (`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_cb_updated`
  ON `crm_customers` (`cyberbiz_updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_crm_customers_incomplete`
  ON `crm_customers` (`id`)
  WHERE `name` = '' OR `address` = '';
