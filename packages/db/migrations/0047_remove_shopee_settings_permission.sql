-- 蝦皮報表設定與店別設定共用 tools:payout:config，不再保留獨立權限。
DELETE FROM role_permissions WHERE permission = 'tools:shopee-sales:config';
--> statement-breakpoint
DELETE FROM user_permissions WHERE permission = 'tools:shopee-sales:config';
