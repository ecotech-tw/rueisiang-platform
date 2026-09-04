/* WMS 的 CYBERBIZ 連結改以 target wms_items.item_id 為 FK，與 legacy inventory_items 解耦。 */
CREATE TABLE `wms_cyberbiz_links` (
  `id` text PRIMARY KEY NOT NULL,
  `wms_item_id` text NOT NULL,
  `cyberbiz_product_id` text NOT NULL,
  `cyberbiz_variant_id` text NOT NULL,
  `sku` text NOT NULL,
  `warehouse_scope` text DEFAULT 'company' NOT NULL,
  `pos_shop_id` integer DEFAULT 0 NOT NULL,
  `sync_status` text DEFAULT 'synced' NOT NULL,
  `last_synced_quantity` integer,
  `last_synced_at` text,
  `last_error` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`wms_item_id`) REFERENCES `wms_items`(`item_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wms_cyberbiz_links_item` ON `wms_cyberbiz_links` (`wms_item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wms_cyberbiz_links_variant` ON `wms_cyberbiz_links` (`cyberbiz_variant_id`);
--> statement-breakpoint
CREATE INDEX `idx_wms_cyberbiz_links_status` ON `wms_cyberbiz_links` (`sync_status`);
--> statement-breakpoint
CREATE INDEX `idx_wms_cyberbiz_links_sku` ON `wms_cyberbiz_links` (`sku`);
--> statement-breakpoint
/* inventory_items.id 不能直接當 target FK；先以 legacy SKU 找 target item，再核對它確實進了 WMS。 */
INSERT OR IGNORE INTO `wms_cyberbiz_links` (
  `id`, `wms_item_id`, `cyberbiz_product_id`, `cyberbiz_variant_id`, `sku`,
  `warehouse_scope`, `pos_shop_id`, `sync_status`, `last_synced_quantity`, `last_synced_at`, `last_error`,
  `created_at`, `updated_at`
)
SELECT
  'backfill:wms-link:' || legacy.`id`,
  target_wms.`item_id`,
  legacy.`cyberbiz_product_id`,
  legacy.`cyberbiz_variant_id`,
  upper(trim(legacy.`sku`)),
  legacy.`warehouse_scope`,
  legacy.`pos_shop_id`,
  legacy.`sync_status`,
  legacy.`last_synced_quantity`,
  legacy.`last_synced_at`,
  legacy.`last_error`,
  legacy.`created_at`,
  legacy.`updated_at`
FROM `cyberbiz_product_links` legacy
JOIN `inventory_items` legacy_item ON legacy_item.`id` = legacy.`inventory_item_id`
JOIN `items` target_item ON target_item.`id` = (
  SELECT candidate.`id`
  FROM `items` candidate
  WHERE lower(candidate.`sku`) = lower(legacy_item.`sku`)
  ORDER BY CASE candidate.`source` WHEN 'custom' THEN 0 ELSE 1 END, candidate.`id`
  LIMIT 1
)
JOIN `wms_items` target_wms ON target_wms.`item_id` = target_item.`id`;
