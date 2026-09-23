-- 扁平任職主檔不再保存到職日期；服務年資起算日獨立保存，避免把年資規則塞回活動狀態欄位。
CREATE TABLE IF NOT EXISTS `hr_employment_service_periods` (
  `employment_id` text PRIMARY KEY NOT NULL,
  `service_start_on` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT "ck_hr_employment_service_periods_date" CHECK(length(`service_start_on`) = 10)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `hr_employment_service_periods` (`employment_id`, `service_start_on`)
SELECT `id`, substr(`created_at`, 1, 10)
FROM `hr_employments`;
