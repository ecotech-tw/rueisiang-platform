/* 既有通路 SKU 對應若能透過唯一用料找到 items，建立 target 外部商品解析。 */
INSERT OR IGNORE INTO `report_external_products` (
  `id`, `source_type`, `external_key`, `external_variant_key`, `external_name`,
  `resolution`, `item_id`, `ignored_reason`
)
SELECT
  'backfill:external:' || p.`id`,
  p.`channel`,
  p.`external_sku`,
  '',
  p.`external_name`,
  'mapped',
  i.`id`,
  ''
FROM `product_sku_mappings` p
JOIN `product_bundle_components` component ON component.`mapping_id` = p.`id`
JOIN `inventory_items` legacy_item ON legacy_item.`id` = component.`inventory_item_id`
JOIN `items` i ON lower(i.`sku`) = lower(legacy_item.`sku`)
WHERE component.`inventory_item_id` IS NOT NULL
  AND legacy_item.`sku` IS NOT NULL
  AND legacy_item.`sku` <> ''
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = p.`id`) = 1;
