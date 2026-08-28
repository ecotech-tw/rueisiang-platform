ALTER TABLE `product_sku_mappings` ADD `external_name` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `product_sku_mappings`
SET `external_name` = (
  SELECT `name`
  FROM `inventory_items`
  WHERE `inventory_items`.`id` = `product_sku_mappings`.`inventory_item_id`
)
WHERE `external_name` = '';
--> statement-breakpoint
INSERT INTO `product_bundle_components` (`mapping_id`, `inventory_item_id`, `quantity`)
SELECT `product_sku_mappings`.`id`, `product_sku_mappings`.`inventory_item_id`, 1
FROM `product_sku_mappings`
WHERE NOT EXISTS (
  SELECT 1
  FROM `product_bundle_components`
  WHERE `product_bundle_components`.`mapping_id` = `product_sku_mappings`.`id`
);
