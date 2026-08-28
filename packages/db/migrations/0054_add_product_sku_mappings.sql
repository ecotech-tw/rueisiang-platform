-- Custom SQL migration file, put your code below! --
CREATE TABLE `product_sku_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`inventory_item_id` text NOT NULL,
	`external_sku` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_sku_mappings_external_sku_unique` ON `product_sku_mappings` (`external_sku`);
--> statement-breakpoint
CREATE INDEX `idx_product_sku_mappings_inventory_item` ON `product_sku_mappings` (`inventory_item_id`);
--> statement-breakpoint
WITH `eligible` AS (
  SELECT
    MIN(`id`) AS `link_id`,
    MIN(`inventory_item_id`) AS `inventory_item_id`,
    UPPER(TRIM(`sku`)) AS `external_sku`
  FROM `cyberbiz_product_links`
  WHERE TRIM(`sku`) <> ''
  GROUP BY UPPER(TRIM(`sku`))
  HAVING COUNT(DISTINCT `inventory_item_id`) = 1
)
INSERT INTO `product_sku_mappings` (`id`, `inventory_item_id`, `external_sku`)
SELECT 'cyberbiz:' || `eligible`.`link_id`, `eligible`.`inventory_item_id`, `eligible`.`external_sku`
FROM `eligible`
INNER JOIN `inventory_items` AS `item` ON `item`.`id` = `eligible`.`inventory_item_id`
WHERE `item`.`sku` IS NOT NULL;
