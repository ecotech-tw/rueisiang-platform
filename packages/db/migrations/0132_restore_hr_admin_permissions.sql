-- HR 權限加入既有系統管理員。新資料庫由 syncSystemRoles 取得完整權限，
-- 但既有資料庫的 admin 角色不會因為程式碼新增 PERMISSIONS 自動長出新授權。
-- 刻意只補不刪，並可安全重跑；之後的權限目錄變更仍由角色同步處理。
INSERT OR IGNORE INTO permissions (permission) VALUES
  ('hr:employee:read'),
  ('hr:employee:write'),
  ('hr:office:read'),
  ('hr:office:write'),
  ('hr:request:review');--> statement-breakpoint

INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT roles.id, permissions.permission
FROM roles
CROSS JOIN permissions
WHERE roles.role_key = 'admin'
  AND roles.is_system = 1
  AND permissions.permission IN (
    'hr:employee:read',
    'hr:employee:write',
    'hr:office:read',
    'hr:office:write',
    'hr:request:review'
  );
