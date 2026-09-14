CREATE TABLE `hr_compensation_items` (
  `id` text PRIMARY KEY NOT NULL,
  `compensation_version_id` text NOT NULL,
  `item_name` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `item_kind` text NOT NULL,
  `include_overtime` integer DEFAULT 0 NOT NULL,
  `include_insurance` integer DEFAULT 0 NOT NULL,
  `include_tax` integer DEFAULT 1 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_by` text NOT NULL,
  FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_compensation_items_name` CHECK(length(trim(`item_name`)) BETWEEN 1 AND 100),
  CONSTRAINT `ck_hr_compensation_items_amount` CHECK(`amount_minor` >= 0),
  CONSTRAINT `ck_hr_compensation_items_kind` CHECK(`item_kind` IN ('fixed', 'variable')),
  CONSTRAINT `ck_hr_compensation_items_flags` CHECK(`include_overtime` IN (0, 1) AND `include_insurance` IN (0, 1) AND `include_tax` IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_hr_compensation_items_version` ON `hr_compensation_items` (`compensation_version_id`);
