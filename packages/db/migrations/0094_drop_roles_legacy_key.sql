-- roles.key 是 role_key 改名之前的舊欄位，#180 用兩支 trigger 讓它跟著 role_key
-- 走，好讓還沒改的 consumer 繼續讀得到。現在沒有任何程式讀它了（API 回應裡的
-- key 欄位來自 admin.ts:94 的 `key: roles.roleKey`，不是這一欄），可以收掉。
--
-- 用 ALTER TABLE DROP COLUMN 而不是重建整張表：roles 底下有四張 ON DELETE CASCADE
-- 的子表（role_permissions、role_permission_grants、user_roles、
-- user_role_assignments），重建就得先把它們全部備份，而這一欄不在主鍵也沒有索引，
-- SQLite 可以直接拿掉。前提是先移除引用它的 trigger。

DROP TRIGGER IF EXISTS `trg_roles_role_key_to_legacy_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_roles_role_key_to_legacy_update`;--> statement-breakpoint
ALTER TABLE `roles` DROP COLUMN `key`;
