-- 逐日出金的編輯與刪除只開給管理者與主管；重跑不會產生重複權限。
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'reports:cyberbiz:write' FROM roles WHERE key IN ('admin', 'manager');
