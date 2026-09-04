/* 將多用料 mapping 收斂到 items + item_components；target 外部商品指向 BOM 父品項。 */
INSERT OR IGNORE INTO `items` (
  `id`, `source`, `kind`, `sku`, `name`, `category_id`, `active`, `created_at`, `updated_at`
)
SELECT
  'custom-report:' || custom.`id`,
  'custom',
  'sellable',
  upper(trim(custom.`sku`)),
  custom.`name`,
  (
    SELECT category.`id`
    FROM `item_categories` category
    WHERE lower(category.`name`) = lower(trim(custom.`category`))
      AND category.`parent_id` IS NULL
    ORDER BY category.`id`
    LIMIT 1
  ),
  1,
  custom.`created_at`,
  custom.`updated_at`
FROM `custom_report_products` custom
WHERE trim(custom.`sku`) <> '';
--> statement-breakpoint
INSERT OR IGNORE INTO `items` (
  `id`, `source`, `kind`, `sku`, `name`, `category_id`, `active`, `created_at`, `updated_at`
)
SELECT
  'report-bundle:' || mapping.`id`,
  'custom',
  'sellable',
  'REPORT-BUNDLE:' || upper(mapping.`id`),
  CASE WHEN trim(mapping.`external_name`) <> '' THEN mapping.`external_name` ELSE mapping.`external_sku` END,
  NULL,
  1,
  mapping.`created_at`,
  mapping.`updated_at`
FROM `product_sku_mappings` mapping
WHERE trim(mapping.`external_sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` component WHERE component.`mapping_id` = mapping.`id`) > 1;
--> statement-breakpoint
/* WMS 用料的 target ID 必須由 SKU 解析；不能把 inventory_items.id 直接塞進新 FK。 */
INSERT OR IGNORE INTO `item_components` (
  `parent_item_id`, `component_item_id`, `quantity`, `created_at`, `updated_at`
)
SELECT
  'report-bundle:' || mapping.`id`,
  target_item.`id`,
  component.`quantity`,
  mapping.`created_at`,
  mapping.`updated_at`
FROM `product_sku_mappings` mapping
JOIN `product_bundle_components` component ON component.`mapping_id` = mapping.`id`
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
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = mapping.`id`) > 1;
--> statement-breakpoint
INSERT OR IGNORE INTO `item_components` (
  `parent_item_id`, `component_item_id`, `quantity`, `created_at`, `updated_at`
)
SELECT
  'report-bundle:' || mapping.`id`,
  target_item.`id`,
  component.`quantity`,
  mapping.`created_at`,
  mapping.`updated_at`
FROM `product_sku_mappings` mapping
JOIN `product_bundle_components` component ON component.`mapping_id` = mapping.`id`
JOIN `custom_report_products` custom ON custom.`id` = component.`custom_product_id`
JOIN `items` target_item ON target_item.`source` = 'custom' AND lower(target_item.`sku`) = lower(custom.`sku`)
WHERE component.`custom_product_id` IS NOT NULL
  AND trim(custom.`sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = mapping.`id`) > 1;
--> statement-breakpoint
INSERT OR IGNORE INTO `item_components` (
  `parent_item_id`, `component_item_id`, `quantity`, `created_at`, `updated_at`
)
SELECT
  'report-bundle:' || mapping.`id`,
  target_item.`id`,
  component.`quantity`,
  mapping.`created_at`,
  mapping.`updated_at`
FROM `product_sku_mappings` mapping
JOIN `product_bundle_components` component ON component.`mapping_id` = mapping.`id`
JOIN `items` target_item ON target_item.`source` = 'cyberbiz' AND lower(target_item.`sku`) = lower(component.`cyberbiz_sku`)
WHERE component.`cyberbiz_sku` IS NOT NULL
  AND trim(component.`cyberbiz_sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = mapping.`id`) > 1;
--> statement-breakpoint
/* 單一自訂用料也要搬到 target；0084 當時不能假設 target 已有 custom item。 */
INSERT OR IGNORE INTO `report_external_products` (
  `id`, `source_type`, `external_key`, `external_variant_key`, `external_name`,
  `resolution`, `item_id`, `ignored_reason`
)
SELECT
  'backfill:external:' || mapping.`id`,
  lower(trim(mapping.`channel`)),
  upper(trim(mapping.`external_sku`)),
  '',
  mapping.`external_name`,
  'mapped',
  target_item.`id`,
  ''
FROM `product_sku_mappings` mapping
JOIN `product_bundle_components` component ON component.`mapping_id` = mapping.`id`
JOIN `custom_report_products` custom ON custom.`id` = component.`custom_product_id`
JOIN `items` target_item ON target_item.`source` = 'custom' AND lower(target_item.`sku`) = lower(custom.`sku`)
WHERE component.`custom_product_id` IS NOT NULL
  AND trim(mapping.`external_sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` sibling WHERE sibling.`mapping_id` = mapping.`id`) = 1;
--> statement-breakpoint
/* 只有全部用料都能解析時才建立外部商品 mapping，避免半套 BOM 靜默少算。 */
INSERT OR IGNORE INTO `report_external_products` (
  `id`, `source_type`, `external_key`, `external_variant_key`, `external_name`,
  `resolution`, `item_id`, `ignored_reason`
)
SELECT
  'backfill:external:' || mapping.`id`,
  lower(trim(mapping.`channel`)),
  upper(trim(mapping.`external_sku`)),
  '',
  mapping.`external_name`,
  'mapped',
  'report-bundle:' || mapping.`id`,
  ''
FROM `product_sku_mappings` mapping
WHERE trim(mapping.`external_sku`) <> ''
  AND (SELECT count(*) FROM `product_bundle_components` component WHERE component.`mapping_id` = mapping.`id`) > 1
  AND (SELECT count(*) FROM `item_components` component WHERE component.`parent_item_id` = 'report-bundle:' || mapping.`id`)
    = (SELECT count(*) FROM `product_bundle_components` component WHERE component.`mapping_id` = mapping.`id`);
--> statement-breakpoint
/* ignore 是明確排除設定，仍然優先於 mapped，包含本支剛搬過來的多用料 mapping。 */
UPDATE `report_external_products`
SET `resolution` = 'ignored', `item_id` = NULL, `ignored_reason` = (
  SELECT ignored_row.`reason`
  FROM `report_sku_ignores` ignored_row
  WHERE lower(trim(ignored_row.`channel`)) = lower(trim(`report_external_products`.`source_type`))
    AND upper(trim(ignored_row.`external_sku`)) = upper(trim(`report_external_products`.`external_key`))
  LIMIT 1
), `updated_at` = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM `report_sku_ignores` ignored_row
  WHERE lower(trim(ignored_row.`channel`)) = lower(trim(`report_external_products`.`source_type`))
    AND upper(trim(ignored_row.`external_sku`)) = upper(trim(`report_external_products`.`external_key`))
);
--> statement-breakpoint
/* 忽略後不再保留 target BOM；取消忽略會回到未對應狀態，而不是偷偷恢復舊 mapping。 */
DELETE FROM `items`
WHERE `id` IN (
  SELECT 'report-bundle:' || mapping.`id`
  FROM `product_sku_mappings` mapping
  JOIN `report_sku_ignores` ignored_row
    ON lower(trim(ignored_row.`channel`)) = lower(trim(mapping.`channel`))
   AND upper(trim(ignored_row.`external_sku`)) = upper(trim(mapping.`external_sku`))
  WHERE (SELECT count(*) FROM `product_bundle_components` component WHERE component.`mapping_id` = mapping.`id`) > 1
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
FROM `report_sku_ignores` ignored_row;
