-- 官網對帳單執行權限加入既有系統管理員。新資料庫由 syncSystemRoles 取得完整權限，
-- 但既有資料庫的 admin 角色不會因為程式碼新增 PERMISSIONS 自動長出新授權，
-- 沒有這一支的話上線後管理者看不到【官網報表執行】，要有人先去按「重新同步」。
-- 跟 0132 一樣只補不刪，並可安全重跑。
INSERT OR IGNORE INTO permissions (permission) VALUES
  ('tools:shop-report:run');--> statement-breakpoint

INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT roles.id, permissions.permission
FROM roles
CROSS JOIN permissions
WHERE roles.role_key = 'admin'
  AND roles.is_system = 1
  AND permissions.permission = 'tools:shop-report:run';
