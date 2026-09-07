-- 蝦皮已經有正式 scope：shopee:store:default。Drive 設定與執行紀錄
-- 收斂到 scopes / report_runs / report_run_scopes，避免營運工具各自保留一套 run 表。
ALTER TABLE `report_run_scopes` ADD `drive_folder_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `report_run_scopes` ADD `drive_folder_name` text DEFAULT '' NOT NULL;--> statement-breakpoint

INSERT OR IGNORE INTO `scopes` (
  `id`, `source_type`, `scope_kind`, `name`, `normalized_name`,
  `drive_folder_url`, `drive_folder_name`, `sort_order`, `active`
)
SELECT
  'shopee:store:default',
  'shopee',
  'store',
  '蝦皮',
  '蝦皮',
  COALESCE((SELECT `drive_folder_url` FROM `shopee_sales_settings` WHERE `id` = 'default'), ''),
  COALESCE((SELECT `drive_folder_name` FROM `shopee_sales_settings` WHERE `id` = 'default'), ''),
  0,
  1;--> statement-breakpoint

UPDATE `scopes`
SET
  `source_type` = 'shopee',
  `scope_kind` = 'store',
  `name` = '蝦皮',
  `normalized_name` = '蝦皮',
  `active` = 1,
  `drive_folder_url` = COALESCE(NULLIF(`drive_folder_url`, ''), (SELECT `drive_folder_url` FROM `shopee_sales_settings` WHERE `id` = 'default'), ''),
  `drive_folder_name` = COALESCE(NULLIF(`drive_folder_name`, ''), (SELECT `drive_folder_name` FROM `shopee_sales_settings` WHERE `id` = 'default'), ''),
  `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'shopee:store:default';--> statement-breakpoint

INSERT OR IGNORE INTO `report_runs` (
  `id`, `request_id`, `source_type`, `imports_sales`, `imports_payout`,
  `period_kind`, `start_date`, `end_date`, `status`, `actor_email`, `created_at`, `updated_at`
)
SELECT
  s.`id`,
  s.`request_id`,
  'shopee',
  1,
  CASE
    WHEN s.`start_date` = substr(s.`start_date`, 1, 7) || '-01'
      AND s.`end_date` = date(s.`start_date`, 'start of month', '+1 month', '-1 day')
    THEN 1 ELSE 0
  END,
  CASE
    WHEN s.`start_date` = substr(s.`start_date`, 1, 7) || '-01'
      AND s.`end_date` = date(s.`start_date`, 'start of month', '+1 month', '-1 day')
    THEN 'month' ELSE 'custom'
  END,
  s.`start_date`,
  s.`end_date`,
  'queued',
  s.`actor_email`,
  s.`created_at`,
  s.`created_at`
FROM `shopee_sales_runs` s
WHERE NOT EXISTS (
  SELECT 1 FROM `report_runs` r WHERE r.`request_id` = s.`request_id`
);--> statement-breakpoint

INSERT OR IGNORE INTO `report_run_scopes` (`report_run_id`, `scope_id`, `drive_folder_url`, `drive_folder_name`)
SELECT
  r.`id`,
  'shopee:store:default',
  s.`drive_folder_url`,
  COALESCE((SELECT `drive_folder_name` FROM `scopes` WHERE `id` = 'shopee:store:default'), '')
FROM `report_runs` r
JOIN `shopee_sales_runs` s ON s.`request_id` = r.`request_id`
WHERE r.`source_type` = 'shopee';--> statement-breakpoint

DROP TABLE `shopee_sales_settings`;--> statement-breakpoint
DROP TABLE `shopee_sales_runs`;
