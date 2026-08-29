-- Custom SQL migration file, put your code below! --
-- system_sku 是跨通路共用的商品識別；外部 SKU 仍保留各通路自己的值。
ALTER TABLE `product_sku_mappings` ADD `system_sku` text;
--> statement-breakpoint
-- 有 WMS 主商品的 mapping 可以直接從 inventory_items 推導系統 SKU。
UPDATE `product_sku_mappings`
SET `system_sku` = UPPER((
  SELECT `sku`
  FROM `inventory_items`
  WHERE `inventory_items`.`id` = `product_sku_mappings`.`inventory_item_id`
))
WHERE `inventory_item_id` IS NOT NULL;
--> statement-breakpoint
-- 舊的自訂 mapping 沒有獨立系統 SKU 欄位，只能先以既有外部 SKU 保留可查詢性；
-- 管理頁可再編輯成真正跨通路共用的系統 SKU。
UPDATE `product_sku_mappings`
SET `system_sku` = UPPER(`external_sku`)
WHERE `system_sku` IS NULL
  AND `inventory_item_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_product_sku_mappings_system_sku`
	ON `product_sku_mappings` (`system_sku`);
