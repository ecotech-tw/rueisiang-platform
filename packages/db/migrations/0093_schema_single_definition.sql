-- schema 檔裡同一張實體表本來有兩個 sqliteTable 定義（#180 改名改到一半留下的），
-- drizzle 只會看見其中一份，另一份宣告的索引與約束就整組消失。把兩份併成一份之後，
-- drizzle 終於看得到那 14 支索引——但它以為那些是新的，會產出 CREATE INDEX。
-- 正式庫其實早就有了，所以這裡一律 IF NOT EXISTS：對正式庫是 no-op，對「從
-- migration 從頭建起來的資料庫」才真的建。
--
-- drizzle 產的版本還會 DROP TABLE users 來加 CHECK。users 底下有四張
-- ON DELETE CASCADE 的子表，而 D1 的 migration 包在一個 transaction 裡、
-- PRAGMA foreign_keys 在裡面是 no-op——那個 DROP 會把所有角色授權刪光。
-- 所以 users 改成先存後補，跟 0092 同一套做法。

CREATE UNIQUE INDEX IF NOT EXISTS `idx_customers_cyberbiz_customer_id` ON `crm_customers` (`cyberbiz_customer_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_customers_normalized_phone` ON `crm_customers` (`normalized_phone`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_customers_status_channel` ON `crm_customers` (`status`,`source_channel`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_customers_updated_at` ON `crm_customers` (`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_customers_cyberbiz_updated_at` ON `crm_customers` (`cyberbiz_updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_customers_incomplete` ON `crm_customers` (`id`) WHERE "crm_customers"."name" = '' OR "crm_customers"."address" = '';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_saved_views_name` ON `crm_saved_views` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_roles_role_key` ON `roles` (`role_key`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_google_subject` ON `users` (`google_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_invitation_token_hash` ON `users` (`invitation_token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_status` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_roles_user` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_status` ON `cyberbiz_webhook_events` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_entity` ON `cyberbiz_webhook_events` (`entity_type`,`external_entity_id`,`received_at`);--> statement-breakpoint

-- 0091 把同一張表的另外兩支索引改了名，這支當時還看不到（schema 沒宣告它），現在補上。
DROP INDEX IF EXISTS `idx_cyberbiz_customer_webhooks_customer`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhook_events_customer` ON `cyberbiz_webhook_events` (`cyberbiz_customer_id`,`received_at`);--> statement-breakpoint

-- users 加上 ck_users_status。四張子表都是 ON DELETE CASCADE，DROP 之前要先存起來。
CREATE TABLE `_users_backup` AS SELECT * FROM `users`;--> statement-breakpoint
CREATE TABLE `_user_roles_backup` AS SELECT * FROM `user_roles`;--> statement-breakpoint
CREATE TABLE `_user_role_assignments_backup` AS SELECT * FROM `user_role_assignments`;--> statement-breakpoint
CREATE TABLE `_user_permissions_backup` AS SELECT * FROM `user_permissions`;--> statement-breakpoint
CREATE TABLE `_user_permission_grants_backup` AS SELECT * FROM `user_permission_grants`;--> statement-breakpoint

DROP TABLE `users`;--> statement-breakpoint

CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`google_subject` text,
	`google_name` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`picture_url` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`password_hash` text,
	`invitation_token_hash` text,
	`invitation_expires_at` text,
	`password_set_at` text,
	`invited_by` text,
	`last_login_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ck_users_status" CHECK("users"."status" IN ('invited', 'active', 'disabled'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_google_subject` ON `users` (`google_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_users_invitation_token_hash` ON `users` (`invitation_token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_users_status` ON `users` (`status`);--> statement-breakpoint

INSERT INTO `users`
  (`id`, `email`, `google_subject`, `google_name`, `display_name`, `picture_url`, `status`,
   `password_hash`, `invitation_token_hash`, `invitation_expires_at`, `password_set_at`,
   `invited_by`, `last_login_at`, `created_at`, `updated_at`)
  SELECT `id`, `email`, `google_subject`, `google_name`, `display_name`, `picture_url`, `status`,
   `password_hash`, `invitation_token_hash`, `invitation_expires_at`, `password_set_at`,
   `invited_by`, `last_login_at`, `created_at`, `updated_at`
  FROM `_users_backup`;--> statement-breakpoint

-- 授權還原。先清空再照備份塞回去，不去猜 DROP TABLE 的隱含 DELETE 有沒有真的
-- 連坐到每一張子表——猜錯的那一邊不是少資料就是主鍵撞車。備份是幾行之前才拍的，
-- 它就是唯一的事實。
--
-- 這四張表兩兩之間還有 #180 留下的雙向同步 trigger（user_roles ↔
-- user_role_assignments、user_permissions ↔ user_permission_grants），
-- 所以每一次 DELETE／INSERT 都會連動到對面。四張都明寫一次，最後的狀態就是備份。
DELETE FROM `user_roles`;--> statement-breakpoint
INSERT INTO `user_roles` SELECT * FROM `_user_roles_backup`;--> statement-breakpoint
DELETE FROM `user_role_assignments`;--> statement-breakpoint
INSERT INTO `user_role_assignments` SELECT * FROM `_user_role_assignments_backup`;--> statement-breakpoint
DELETE FROM `user_permissions`;--> statement-breakpoint
INSERT INTO `user_permissions` SELECT * FROM `_user_permissions_backup`;--> statement-breakpoint
DELETE FROM `user_permission_grants`;--> statement-breakpoint
INSERT INTO `user_permission_grants` SELECT * FROM `_user_permission_grants_backup`;--> statement-breakpoint

DROP TABLE `_users_backup`;--> statement-breakpoint
DROP TABLE `_user_roles_backup`;--> statement-breakpoint
DROP TABLE `_user_role_assignments_backup`;--> statement-breakpoint
DROP TABLE `_user_permissions_backup`;--> statement-breakpoint
DROP TABLE `_user_permission_grants_backup`;
