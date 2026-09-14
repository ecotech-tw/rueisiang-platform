CREATE TABLE `hr_bonus_policy_version_scopes` (
  `policy_version_id` text NOT NULL,
  `scope_id` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY(`policy_version_id`, `scope_id`),
  FOREIGN KEY (`policy_version_id`) REFERENCES `hr_bonus_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_policy_version_scopes_scope` ON `hr_bonus_policy_version_scopes` (`scope_id`,`policy_version_id`);
--> statement-breakpoint
INSERT INTO `hr_bonus_policy_version_scopes` (`policy_version_id`, `scope_id`, `created_by`)
SELECT `id`, `scope_id`, `created_by`
FROM `hr_bonus_policy_versions`;
