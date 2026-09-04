/* 將單一用料的舊通路 mapping 搬到 target 外部商品解析；多用料資料先保留在 legacy 表。 */
/* component.inventory_item_id 是舊 inventory_items 的 ID；不能把它直接當成 target FK。 */
INSERT OR IGNORE INTO `report_external_products` (
  `id`, `source_type`, `external_key`, `external_variant_key`, `external_name`,
  `resolution`, `item_id`, `ignored_reason`
)
SELECT
  'backfill:external:' || p.`id`,
  lower(trim(p.`channel`)),
  upper(trim(p.`external_sku`)),
  '',
  p.`external_name`,
  'mapped',
  target_item.`id`,
  ''
FROM `product_sku_mappings` p
JOIN `product_bundle_components` component ON component.`mapping_id` = p.`id`
JOIN `inventory_items` legacy_item ON legacy_item.`id` = component.`inventory_item_id`
JOIN `items` target_item ON target_item.`id` = (
  SELECT candidate.`id`
  FROM `items` candidate
  WHERE lower(candidate.`sku`) = lower(legacy_item.`sku`)
  ORDER BY CASE candidate.`source` WHEN 'custom' THEN 0 ELSE 1 END, candidate.`id`
  LIMIT 1
)
WHERE component.`inventory_item_id` IS NOT NULL
  AND legacy_item.`sku` IS NOT NULL
  AND trim(legacy_item.`sku`) <> ''
  AND trim(p.`external_sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = p.`id`) = 1;
--> statement-breakpoint
/* 0081 可能已先用 SKU 建立同一筆資料；把既有列也修正到同一個 deterministic target item。 */
UPDATE `report_external_products`
SET `source_type` = (
  SELECT lower(trim(p.`channel`))
  FROM `product_sku_mappings` p
  WHERE `report_external_products`.`id` = 'backfill:external:' || p.`id`
  LIMIT 1
),
`external_key` = (
  SELECT upper(trim(p.`external_sku`))
  FROM `product_sku_mappings` p
  WHERE `report_external_products`.`id` = 'backfill:external:' || p.`id`
  LIMIT 1
),
`item_id` = (
  SELECT candidate.`id`
  FROM `product_sku_mappings` p
  JOIN `product_bundle_components` component ON component.`mapping_id` = p.`id`
  JOIN `inventory_items` legacy_item ON legacy_item.`id` = component.`inventory_item_id`
  JOIN `items` candidate ON lower(candidate.`sku`) = lower(legacy_item.`sku`)
  WHERE `report_external_products`.`id` = 'backfill:external:' || p.`id`
    AND component.`inventory_item_id` IS NOT NULL
    AND legacy_item.`sku` IS NOT NULL
    AND trim(legacy_item.`sku`) <> ''
    AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = p.`id`) = 1
  ORDER BY CASE candidate.`source` WHEN 'custom' THEN 0 ELSE 1 END, candidate.`id`
  LIMIT 1
)
WHERE `report_external_products`.`resolution` = 'mapped'
  AND EXISTS (
    SELECT 1
    FROM `product_sku_mappings` p
    JOIN `product_bundle_components` component ON component.`mapping_id` = p.`id`
    JOIN `inventory_items` legacy_item ON legacy_item.`id` = component.`inventory_item_id`
    JOIN `items` candidate ON lower(candidate.`sku`) = lower(legacy_item.`sku`)
    WHERE `report_external_products`.`id` = 'backfill:external:' || p.`id`
      AND component.`inventory_item_id` IS NOT NULL
      AND legacy_item.`sku` IS NOT NULL
      AND trim(legacy_item.`sku`) <> ''
      AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = p.`id`) = 1
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `report_external_products` (
  `id`, `source_type`, `external_key`, `external_variant_key`, `external_name`,
  `resolution`, `item_id`, `ignored_reason`
)
SELECT
  'backfill:external:' || p.`id`,
  lower(trim(p.`channel`)),
  upper(trim(p.`external_sku`)),
  '',
  p.`external_name`,
  'mapped',
  i.`id`,
  ''
FROM `product_sku_mappings` p
JOIN `product_bundle_components` component ON component.`mapping_id` = p.`id`
JOIN `custom_report_products` custom ON custom.`id` = component.`custom_product_id`
JOIN `items` i ON i.`source` = 'custom' AND lower(i.`sku`) = lower(custom.`sku`)
WHERE component.`custom_product_id` IS NOT NULL
  AND trim(p.`external_sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = p.`id`) = 1;
--> statement-breakpoint
INSERT OR IGNORE INTO `report_external_products` (
  `id`, `source_type`, `external_key`, `external_variant_key`, `external_name`,
  `resolution`, `item_id`, `ignored_reason`
)
SELECT
  'backfill:external:' || p.`id`,
  lower(trim(p.`channel`)),
  upper(trim(p.`external_sku`)),
  '',
  p.`external_name`,
  'mapped',
  i.`id`,
  ''
FROM `product_sku_mappings` p
JOIN `product_bundle_components` component ON component.`mapping_id` = p.`id`
JOIN `items` i ON i.`source` = 'cyberbiz' AND lower(i.`sku`) = lower(component.`cyberbiz_sku`)
WHERE component.`cyberbiz_sku` IS NOT NULL
  AND trim(p.`external_sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = p.`id`) = 1;
--> statement-breakpoint
/* ignore 是明確排除設定，若與 mapping 撞鍵，以 ignore 為準。 */
UPDATE `report_external_products`
SET `resolution` = 'ignored', `item_id` = NULL, `ignored_reason` = (
  SELECT ignored_row.`reason`
  FROM `report_sku_ignores` AS ignored_row
  WHERE lower(trim(ignored_row.`channel`)) = lower(trim(`report_external_products`.`source_type`))
    AND upper(trim(ignored_row.`external_sku`)) = upper(trim(`report_external_products`.`external_key`))
  LIMIT 1
), `updated_at` = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM `report_sku_ignores` AS ignored_row
  WHERE lower(trim(ignored_row.`channel`)) = lower(trim(`report_external_products`.`source_type`))
    AND upper(trim(ignored_row.`external_sku`)) = upper(trim(`report_external_products`.`external_key`))
);
--> statement-breakpoint
INSERT OR IGNORE INTO `report_external_products` (
  `id`, `source_type`, `external_key`, `external_variant_key`, `external_name`,
  `resolution`, `item_id`, `ignored_reason`
)
SELECT
  'backfill:ignore:' || ignored_row.`id`,
  lower(trim(ignored_row.`channel`)),
  upper(trim(ignored_row.`external_sku`)),
  '',
  '',
  'ignored',
  NULL,
  ignored_row.`reason`
FROM `report_sku_ignores` AS ignored_row;
