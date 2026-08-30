-- 營運統計是管理者專用的查閱權限；重跑不會產生重複資料。
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'reports:analytics:read' FROM roles WHERE key = 'admin';
