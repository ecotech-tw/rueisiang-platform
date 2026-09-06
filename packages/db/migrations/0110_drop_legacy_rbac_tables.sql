-- RBAC 的新舊表並存到此為止。
--
-- #180 用 expand 的方式搬 RBAC：新表建起來、資料複製過去，再用 13 支雙向同步的
-- trigger 讓兩邊跟著彼此走，好讓還沒改的 consumer 繼續讀舊表。contract 一直沒做。
--
-- 現在可以收了，三件事都確認過：
--   1. 正式程式碼沒有任何一處讀寫舊表（只有測試與 dev fixtures，本次一併改掉）
--   2. 三對表完全同步，各自 0 筆漂移
--   3. 授權判定走的是 user_role_assignments 與 *_grants
--
-- ⚠️ user_roles 有 scope_type / scope_id 兩欄（值全部是空字串），
--    user_role_assignments 沒有。docs/platform-schema-target.sql 的
--    user_role_assignments 就是 PRIMARY KEY (user_id, role_id)，沒有範圍欄位——
--    那是逐表 review 過的決定。所以這裡是照設計收掉，不是漏搬。
--    rbac.ts 原本寫「欄位仍然留著，不必再開一次 migration」，那句話跟著改掉了：
--    哪天真的要做資料範圍過濾，要開一支 migration 把欄位加到新表上。

-- 1. 先拆 trigger。留著的話 DROP TABLE 會觸發它們去寫另一張已經不存在的表。
DROP TRIGGER IF EXISTS `trg_role_permission_grants_to_legacy_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_role_permission_grants_to_legacy_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_role_permissions_to_grants_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_role_permissions_to_grants_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_permission_grants_to_legacy_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_permissions_to_grants_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_permissions_to_grants_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_role_assignments_to_legacy_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_role_assignments_to_legacy_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_role_assignments_to_legacy_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_roles_to_assignments_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_roles_to_assignments_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_user_roles_to_assignments_delete`;--> statement-breakpoint

-- 2. 再刪表。這三張沒有任何子表指著它們（user_roles 是 users 與 roles 的子表，
--    不是誰的父表），所以 DROP 不會連坐到別的資料。
DROP TABLE IF EXISTS `user_roles`;--> statement-breakpoint
DROP TABLE IF EXISTS `user_permissions`;--> statement-breakpoint
DROP TABLE IF EXISTS `role_permissions`;
