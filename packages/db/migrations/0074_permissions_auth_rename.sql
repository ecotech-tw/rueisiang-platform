CREATE TABLE `permissions` (
	`permission` text PRIMARY KEY NOT NULL,
	`synced_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `roles` RENAME COLUMN `key` TO `role_key`;
--> statement-breakpoint
ALTER TABLE `roles` ADD `key` text;
--> statement-breakpoint
UPDATE `roles` SET `key` = `role_key`;
--> statement-breakpoint
/* SQLite／D1 不允許 ADD COLUMN 使用 CURRENT_TIMESTAMP 作為非固定 default；先加欄位，再回填既有資料。 */
ALTER TABLE `roles` ADD `updated_at` text;
--> statement-breakpoint
UPDATE `roles` SET `updated_at` = CURRENT_TIMESTAMP WHERE `updated_at` IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_roles_key`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_roles_role_key` ON `roles` (`role_key`);
--> statement-breakpoint
CREATE TRIGGER `trg_roles_role_key_to_legacy_insert` AFTER INSERT ON `roles`
BEGIN
  UPDATE `roles` SET `key` = NEW.`role_key` WHERE `id` = NEW.`id` AND `key` IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_roles_role_key_to_legacy_update` AFTER UPDATE OF `role_key` ON `roles`
BEGIN
  UPDATE `roles` SET `key` = NEW.`role_key` WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `name` TO `google_name`;
--> statement-breakpoint
CREATE TABLE `role_permission_grants` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `role_permission_grants` (`role_id`, `permission`, `created_at`)
SELECT `role_id`, `permission`, CURRENT_TIMESTAMP FROM `role_permissions`;
--> statement-breakpoint
CREATE TABLE `user_role_assignments` (
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`granted_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `role_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `user_role_assignments` (`user_id`, `role_id`, `granted_by`, `created_at`)
SELECT `user_id`, `role_id`, `granted_by`, `created_at` FROM `user_roles`;
--> statement-breakpoint
CREATE TABLE `user_permission_grants` (
	`user_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `permission`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `user_permission_grants` (`user_id`, `permission`, `granted_by`, `created_at`)
SELECT `user_id`, `permission`, `granted_by`, `created_at` FROM `user_permissions`;
--> statement-breakpoint
CREATE INDEX `idx_role_permission_grants_permission` ON `role_permission_grants` (`permission`);
--> statement-breakpoint
CREATE INDEX `idx_user_permission_grants_permission` ON `user_permission_grants` (`permission`);
--> statement-breakpoint
CREATE TRIGGER `trg_role_permission_grants_to_legacy_insert` AFTER INSERT ON `role_permission_grants`
BEGIN
  INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission`) VALUES (NEW.`role_id`, NEW.`permission`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_role_permissions_to_grants_insert` AFTER INSERT ON `role_permissions`
BEGIN
  INSERT OR IGNORE INTO `role_permission_grants` (`role_id`, `permission`) VALUES (NEW.`role_id`, NEW.`permission`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_role_permissions_to_grants_delete` AFTER DELETE ON `role_permissions`
BEGIN
  DELETE FROM `role_permission_grants` WHERE `role_id` = OLD.`role_id` AND `permission` = OLD.`permission`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_role_permission_grants_to_legacy_delete` AFTER DELETE ON `role_permission_grants`
BEGIN
  DELETE FROM `role_permissions` WHERE `role_id` = OLD.`role_id` AND `permission` = OLD.`permission`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_roles_to_assignments_insert` AFTER INSERT ON `user_roles`
BEGIN
  INSERT OR IGNORE INTO `user_role_assignments` (`user_id`, `role_id`, `granted_by`, `created_at`) VALUES (NEW.`user_id`, NEW.`role_id`, NEW.`granted_by`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_role_assignments_to_legacy_insert` AFTER INSERT ON `user_role_assignments`
BEGIN
  INSERT OR IGNORE INTO `user_roles` (`user_id`, `role_id`, `granted_by`, `created_at`) VALUES (NEW.`user_id`, NEW.`role_id`, NEW.`granted_by`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_roles_to_assignments_update` AFTER UPDATE ON `user_roles`
BEGIN
  DELETE FROM `user_role_assignments` WHERE `user_id` = OLD.`user_id` AND `role_id` = OLD.`role_id`;
  INSERT OR IGNORE INTO `user_role_assignments` (`user_id`, `role_id`, `granted_by`, `created_at`) VALUES (NEW.`user_id`, NEW.`role_id`, NEW.`granted_by`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_role_assignments_to_legacy_update` AFTER UPDATE ON `user_role_assignments`
BEGIN
  DELETE FROM `user_roles` WHERE `user_id` = OLD.`user_id` AND `role_id` = OLD.`role_id`;
  INSERT OR IGNORE INTO `user_roles` (`user_id`, `role_id`, `granted_by`, `created_at`) VALUES (NEW.`user_id`, NEW.`role_id`, NEW.`granted_by`, NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_roles_to_assignments_delete` AFTER DELETE ON `user_roles`
BEGIN
  DELETE FROM `user_role_assignments` WHERE `user_id` = OLD.`user_id` AND `role_id` = OLD.`role_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_role_assignments_to_legacy_delete` AFTER DELETE ON `user_role_assignments`
BEGIN
  DELETE FROM `user_roles` WHERE `user_id` = OLD.`user_id` AND `role_id` = OLD.`role_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_permission_grants_to_legacy_insert` AFTER INSERT ON `user_permission_grants`
BEGIN
  INSERT OR IGNORE INTO `user_permissions` (`user_id`, `permission`, `granted_by`) VALUES (NEW.`user_id`, NEW.`permission`, NEW.`granted_by`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_permissions_to_grants_insert` AFTER INSERT ON `user_permissions`
BEGIN
  INSERT OR IGNORE INTO `user_permission_grants` (`user_id`, `permission`, `granted_by`) VALUES (NEW.`user_id`, NEW.`permission`, NEW.`granted_by`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_user_permissions_to_grants_delete` AFTER DELETE ON `user_permissions`
BEGIN
  DELETE FROM `user_permission_grants` WHERE `user_id` = OLD.`user_id` AND `permission` = OLD.`permission`;
END;
