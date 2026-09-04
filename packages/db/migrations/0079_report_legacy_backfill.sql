/* 將既有報表快照搬到 item_id 粒度；無法對到品項主檔的列保留在 legacy 表供人工處理。 */
INSERT OR IGNORE INTO `items` (`id`, `source`, `kind`, `sku`, `name`, `category_id`, `active`)
SELECT
  'custom:report-product:' || lower(hex(randomblob(8))),
  'custom', 'sellable', p.`sku`, p.`name`, NULL, 1
FROM `custom_report_products` p
WHERE NOT EXISTS (SELECT 1 FROM `items` i WHERE lower(i.`sku`) = lower(p.`sku`));
--> statement-breakpoint
INSERT OR IGNORE INTO `report_runs` (
  `id`, `request_id`, `source_type`, `imports_sales`, `period_kind`, `start_date`, `end_date`,
  `status`, `imported_sales_rows`, `actor_email`
)
SELECT
  'backfill:sales:' || r.`scope_id` || ':' || r.`report_month`,
  'backfill:sales:' || r.`scope_id` || ':' || r.`report_month`,
  'legacy', 1, 'month',
  r.`report_month` || '-01',
  date(r.`report_month` || '-01', 'start of month', '+1 month', '-1 day'),
  'succeeded', count(*), ''
FROM `report_sales_monthly` r
JOIN `scopes` s ON s.`id` = r.`scope_id`
GROUP BY r.`scope_id`, r.`report_month`;
--> statement-breakpoint
INSERT OR IGNORE INTO `report_run_scopes` (`report_run_id`, `scope_id`)
SELECT DISTINCT
  'backfill:sales:' || r.`scope_id` || ':' || r.`report_month`, r.`scope_id`
FROM `report_sales_monthly` r
JOIN `scopes` s ON s.`id` = r.`scope_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `report_item_sales_monthly` (
  `scope_id`, `report_month`, `item_id`, `record_origin`, `report_run_id`,
  `gross_quantity`, `return_quantity`, `net_quantity`, `sales_amount`
)
SELECT
  r.`scope_id`, r.`report_month`, i.`id`, 'imported',
  'backfill:sales:' || r.`scope_id` || ':' || r.`report_month`,
  r.`gross_quantity`, r.`return_quantity`, r.`net_quantity`, r.`sales_amount`
FROM `report_sales_monthly` r
JOIN `scopes` s ON s.`id` = r.`scope_id`
JOIN `items` i ON lower(i.`sku`) = lower(r.`sku`);
