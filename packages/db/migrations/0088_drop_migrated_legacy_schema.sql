/* target schema 已完成 backfill；最後移除已由 items／WMS／Report target 取代的 legacy 表。 */
/* 人工報表也要在刪除舊表前搬入同一張 target fact table，否則會遺失可覆蓋匯入資料的歷史修訂。 */
INSERT OR IGNORE INTO `items` (`id`, `source`, `kind`, `sku`, `name`, `category_id`, `active`, `created_at`, `updated_at`)
SELECT
  'report-manual:' || r.`sku_source` || ':' || upper(trim(r.`sku`)),
  r.`sku_source`, 'sellable', upper(trim(r.`sku`)),
  COALESCE(NULLIF(trim(r.`product_name`), ''), upper(trim(r.`sku`))),
  category.`id`, 1, r.`created_at`, r.`updated_at`
FROM `report_manual_sales_monthly` r
LEFT JOIN `item_categories` category ON category.`name` = r.`category`
WHERE NOT EXISTS (
  SELECT 1 FROM `items` item
  WHERE item.`source` = r.`sku_source`
    AND upper(trim(item.`sku`)) = upper(trim(r.`sku`))
);
--> statement-breakpoint
INSERT OR IGNORE INTO `report_item_sales_monthly` (
  `scope_id`, `report_month`, `item_id`, `record_origin`, `report_run_id`,
  `gross_quantity`, `return_quantity`, `net_quantity`, `sales_amount`,
  `updated_by_email`, `created_at`, `updated_at`
)
SELECT
  r.`scope_id`, r.`report_month`, item.`id`, 'manual', NULL,
  r.`gross_quantity`, r.`return_quantity`, r.`net_quantity`, r.`sales_amount`,
  r.`updated_by_email`, r.`created_at`, r.`updated_at`
FROM `report_manual_sales_monthly` r
JOIN `scopes` scope ON scope.`id` = r.`scope_id`
JOIN `items` item
  ON item.`source` = r.`sku_source`
 AND upper(trim(item.`sku`)) = upper(trim(r.`sku`));
--> statement-breakpoint
INSERT OR IGNORE INTO `report_payout_daily_target` (
  `scope_id`, `business_date`, `record_origin`, `report_run_id`, `payout_amount`,
  `updated_by_email`, `created_at`, `updated_at`
)
SELECT
  r.`scope_id`, r.`business_date`, 'manual', NULL, r.`payout_amount`,
  r.`updated_by_email`, r.`created_at`, r.`updated_at`
FROM `report_manual_payout_daily` r
JOIN `scopes` scope ON scope.`id` = r.`scope_id`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cyberbiz_products_compat_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cyberbiz_products_compat_update`;
--> statement-breakpoint
DROP VIEW IF EXISTS `cyberbiz_products_compat`;
--> statement-breakpoint
DROP TABLE IF EXISTS `cyberbiz_product_links`;
--> statement-breakpoint
DROP TABLE IF EXISTS `zone_images`;
--> statement-breakpoint
DROP TABLE IF EXISTS `product_bundle_components`;
--> statement-breakpoint
DROP TABLE IF EXISTS `cyberbiz_product_categories`;
--> statement-breakpoint
DROP TABLE IF EXISTS `product_sku_mappings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `report_sku_ignores`;
--> statement-breakpoint
DROP TABLE IF EXISTS `custom_report_products`;
--> statement-breakpoint
DROP TABLE IF EXISTS `cyberbiz_products_legacy`;
--> statement-breakpoint
DROP TABLE IF EXISTS `report_sales_monthly`;
--> statement-breakpoint
DROP TABLE IF EXISTS `report_payout_daily`;
--> statement-breakpoint
DROP TABLE IF EXISTS `report_manual_sales_monthly`;
--> statement-breakpoint
DROP TABLE IF EXISTS `report_manual_payout_daily`;
--> statement-breakpoint
DROP TABLE IF EXISTS `report_product_categories`;
--> statement-breakpoint
DROP TABLE IF EXISTS `report_scopes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `cyberbiz_report_runs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `payout_runs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `inventory_items`;
--> statement-breakpoint
DROP TABLE IF EXISTS `zones`;
--> statement-breakpoint
DROP TABLE IF EXISTS `warehouse_categories`;
--> statement-breakpoint
DROP TABLE IF EXISTS `product_categories`;
--> statement-breakpoint
DROP TABLE IF EXISTS `warehouse_settings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `layout_elements`;
