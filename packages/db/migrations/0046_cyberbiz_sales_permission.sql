-- 商品銷售報表執行權限要補給既有的管理者與主管；重跑不會產生重複資料。
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:cyberbiz-sales:run' FROM roles WHERE key IN ('admin', 'manager');
