-- 新增的 HR 範圍與稽核權限必須補進既有 admin，否則部署後管理者會看不到新入口。
-- 只新增不刪除，重跑不會改動既有自訂角色或直接授權。
INSERT OR IGNORE INTO permissions (permission) VALUES
  ('hr:scope:read'),
  ('hr:scope:write'),
  ('hr:audit:read');--> statement-breakpoint

INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT roles.id, permissions.permission
FROM roles
CROSS JOIN permissions
WHERE roles.role_key = 'admin'
  AND roles.is_system = 1
  AND permissions.permission IN ('hr:scope:read', 'hr:scope:write', 'hr:audit:read');
