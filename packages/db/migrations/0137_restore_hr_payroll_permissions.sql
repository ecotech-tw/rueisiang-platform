-- 薪資與獎金 API 的權限加入既有系統管理員。
-- 新資料庫由 syncSystemRoles 取得完整權限；這支 migration 讓既有 admin
-- 不必等人工呼叫同步就能使用新的人事功能，且可安全重跑。
INSERT OR IGNORE INTO permissions (permission) VALUES
  ('hr:schedule:read'),
  ('hr:schedule:write'),
  ('hr:overtime:read'),
  ('hr:overtime:write'),
  ('hr:payroll:read'),
  ('hr:payroll:calculate'),
  ('hr:bonus:read'),
  ('hr:bonus:write'),
  ('hr:bonus:calculate');--> statement-breakpoint

INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT roles.id, permissions.permission
FROM roles
CROSS JOIN permissions
WHERE roles.role_key = 'admin'
  AND roles.is_system = 1
  AND permissions.permission IN (
    'hr:schedule:read',
    'hr:schedule:write',
    'hr:overtime:read',
    'hr:overtime:write',
    'hr:payroll:read',
    'hr:payroll:calculate',
    'hr:bonus:read',
    'hr:bonus:write',
    'hr:bonus:calculate'
  );
