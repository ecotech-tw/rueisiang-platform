-- CLAUDE.md 對 permissions 鏡像表寫得很清楚：
--   「存在的理由只有一個——讓授權表有外鍵可以指，擋掉打錯字的鍵值。」
--   「鏡像表的外鍵一律 ON DELETE RESTRICT。」
--
-- 正式庫兩件事都沒發生：鏡像表只有 6 列（程式宣告 42 個），而且沒有任何授權表
-- 有外鍵指向它。那張表現在什麼都沒做。
--
-- 應用層是有擋的（createRole 與 updateRole 都會過 findUnknownPermission），但那是
-- 唯一一道。任何忘了檢查的新路徑、批次匯入或直接下 SQL 都能塞進打錯字的鍵值，
-- 而且不會報錯——那個角色會顯示有這個權限，實際上什麼都開不了。
--
-- 這一支補齊鏡像並把外鍵掛上。只掛在 role_permission_grants 與
-- user_permission_grants 這兩張「程式真的在讀」的表上；role_permissions 與
-- user_permissions 是 trigger 維護的舊表，本來就要收掉，不值得為它們重建一次。
-- 就算有人直接寫舊表，trigger 會把它鏡到 grants 那邊，然後撞上這裡的外鍵而中止。

-- 1. 鏡像補齊。來源是「授權表現在實際用到的鍵值」——Phase 0.5 驗證過那 42 個
--    全部對得上程式碼。之後由 syncSystemRoles 以 permissions.ts 為準維護。
INSERT OR IGNORE INTO `permissions` (`permission`, `synced_at`)
SELECT DISTINCT `permission`, CURRENT_TIMESTAMP FROM `role_permission_grants`;--> statement-breakpoint
INSERT OR IGNORE INTO `permissions` (`permission`, `synced_at`)
SELECT DISTINCT `permission`, CURRENT_TIMESTAMP FROM `user_permission_grants`;--> statement-breakpoint

-- 2. 先把兩邊的同步 trigger 全部拆掉。
--    建在 grants 表上的那三支會跟著 DROP TABLE 一起消失，但舊表那邊的四支不會，
--    而 ALTER TABLE ... RENAME 會重新解析資料庫裡每一支 trigger——那時 grants 表
--    還不存在，整支 migration 會以 "no such table" 中止。
DROP TRIGGER IF EXISTS `trg_role_permissions_to_grants_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_role_permissions_to_grants_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_permissions_to_grants_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_permissions_to_grants_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_role_permission_grants_to_legacy_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_role_permission_grants_to_legacy_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_permission_grants_to_legacy_insert`;--> statement-breakpoint

-- 3. 兩張授權表加外鍵。SQLite 加不了外鍵，只能重建。
CREATE TABLE `__new_role_permission_grants` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission`) REFERENCES `permissions`(`permission`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_role_permission_grants` (`role_id`, `permission`, `created_at`)
  SELECT `role_id`, `permission`, `created_at` FROM `role_permission_grants`;--> statement-breakpoint
DROP TABLE `role_permission_grants`;--> statement-breakpoint
ALTER TABLE `__new_role_permission_grants` RENAME TO `role_permission_grants`;--> statement-breakpoint

CREATE TABLE `__new_user_permission_grants` (
	`user_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `permission`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission`) REFERENCES `permissions`(`permission`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_user_permission_grants` (`user_id`, `permission`, `granted_by`, `created_at`)
  SELECT `user_id`, `permission`, `granted_by`, `created_at` FROM `user_permission_grants`;--> statement-breakpoint
DROP TABLE `user_permission_grants`;--> statement-breakpoint
ALTER TABLE `__new_user_permission_grants` RENAME TO `user_permission_grants`;--> statement-breakpoint

-- 4. 索引也跟著表被刪掉了（0074 建的那兩支），補回來。
CREATE INDEX IF NOT EXISTS `idx_role_permission_grants_permission` ON `role_permission_grants` (`permission`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_user_permission_grants_permission` ON `user_permission_grants` (`permission`);--> statement-breakpoint

-- 5. 七支 trigger 原樣補回來。少補一支就會讓新舊兩張授權表從這一刻起開始漂移，
--    而且沒有任何地方會報錯。
CREATE TRIGGER `trg_role_permission_grants_to_legacy_insert` AFTER INSERT ON `role_permission_grants`
BEGIN
  INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission`) VALUES (NEW.`role_id`, NEW.`permission`);
END;--> statement-breakpoint
CREATE TRIGGER `trg_role_permission_grants_to_legacy_delete` AFTER DELETE ON `role_permission_grants`
BEGIN
  DELETE FROM `role_permissions` WHERE `role_id` = OLD.`role_id` AND `permission` = OLD.`permission`;
END;--> statement-breakpoint
CREATE TRIGGER `trg_user_permission_grants_to_legacy_insert` AFTER INSERT ON `user_permission_grants`
BEGIN
  INSERT OR IGNORE INTO `user_permissions` (`user_id`, `permission`, `granted_by`) VALUES (NEW.`user_id`, NEW.`permission`, NEW.`granted_by`);
END;--> statement-breakpoint

CREATE TRIGGER `trg_role_permissions_to_grants_insert` AFTER INSERT ON `role_permissions`
BEGIN
  INSERT OR IGNORE INTO `role_permission_grants` (`role_id`, `permission`) VALUES (NEW.`role_id`, NEW.`permission`);
END;--> statement-breakpoint
CREATE TRIGGER `trg_role_permissions_to_grants_delete` AFTER DELETE ON `role_permissions`
BEGIN
  DELETE FROM `role_permission_grants` WHERE `role_id` = OLD.`role_id` AND `permission` = OLD.`permission`;
END;--> statement-breakpoint
CREATE TRIGGER `trg_user_permissions_to_grants_insert` AFTER INSERT ON `user_permissions`
BEGIN
  INSERT OR IGNORE INTO `user_permission_grants` (`user_id`, `permission`, `granted_by`) VALUES (NEW.`user_id`, NEW.`permission`, NEW.`granted_by`);
END;--> statement-breakpoint
CREATE TRIGGER `trg_user_permissions_to_grants_delete` AFTER DELETE ON `user_permissions`
BEGIN
  DELETE FROM `user_permission_grants` WHERE `user_id` = OLD.`user_id` AND `permission` = OLD.`permission`;
END;
