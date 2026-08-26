-- 蝦皮報表設定與店別設定共用 tools:payout:config，不再保留獨立權限。
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT role_id, 'tools:payout:config'
FROM role_permissions
WHERE permission = 'tools:shopee-sales:config';
--> statement-breakpoint
INSERT OR IGNORE INTO user_permissions (user_id, permission, granted_by)
SELECT user_id, 'tools:payout:config', granted_by
FROM user_permissions
WHERE permission = 'tools:shopee-sales:config';
--> statement-breakpoint
DELETE FROM role_permissions WHERE permission = 'tools:shopee-sales:config';
--> statement-breakpoint
DELETE FROM user_permissions WHERE permission = 'tools:shopee-sales:config';
