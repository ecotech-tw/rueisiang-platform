/* payout 先使用獨立 target table，避免直接重建既有 legacy table 造成歷史出金遺失。 */
CREATE TABLE `report_payout_daily_target` (
  `scope_id` text NOT NULL,
  `business_date` text NOT NULL,
  `record_origin` text NOT NULL,
  `report_run_id` text,
  `payout_amount` integer DEFAULT 0 NOT NULL,
  `updated_by_email` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (`scope_id`, `business_date`, `record_origin`),
  FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON DELETE restrict,
  FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON DELETE restrict,
  CHECK (`record_origin` IN ('imported', 'manual')),
  CHECK ((`record_origin` = 'imported') = (`report_run_id` IS NOT NULL)),
  CHECK (`record_origin` = 'manual' OR `updated_by_email` = '')
);
--> statement-breakpoint
CREATE INDEX `idx_payout_target_date` ON `report_payout_daily_target` (`business_date`, `scope_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `report_runs` (
  `id`, `request_id`, `source_type`, `imports_payout`, `period_kind`, `start_date`, `end_date`,
  `status`, `imported_payout_rows`, `actor_email`
)
SELECT
  'backfill:payout:' || p.`scope_id` || ':' || substr(p.`business_date`, 1, 7),
  'backfill:payout:' || p.`scope_id` || ':' || substr(p.`business_date`, 1, 7),
  'legacy', 1, 'month',
  substr(p.`business_date`, 1, 7) || '-01',
  date(substr(p.`business_date`, 1, 7) || '-01', 'start of month', '+1 month', '-1 day'),
  'succeeded', count(*), ''
FROM `report_payout_daily` p
JOIN `scopes` s ON s.`id` = p.`scope_id`
GROUP BY p.`scope_id`, substr(p.`business_date`, 1, 7);
--> statement-breakpoint
INSERT OR IGNORE INTO `report_run_scopes` (`report_run_id`, `scope_id`)
SELECT DISTINCT
  'backfill:payout:' || p.`scope_id` || ':' || substr(p.`business_date`, 1, 7), p.`scope_id`
FROM `report_payout_daily` p
JOIN `scopes` s ON s.`id` = p.`scope_id`;
--> statement-breakpoint
INSERT OR IGNORE INTO `report_payout_daily_target` (
  `scope_id`, `business_date`, `record_origin`, `report_run_id`, `payout_amount`
)
SELECT
  p.`scope_id`, p.`business_date`, 'imported',
  'backfill:payout:' || p.`scope_id` || ':' || substr(p.`business_date`, 1, 7),
  p.`payout_amount`
FROM `report_payout_daily` p
JOIN `scopes` s ON s.`id` = p.`scope_id`;
