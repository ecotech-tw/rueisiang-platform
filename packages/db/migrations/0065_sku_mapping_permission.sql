-- SKU 對應從倉儲移到營運工具，權限鍵值跟著換。既有的管理者與主管要補上新的兩個，
-- 否則升級之後那一頁會從側欄消失。重跑不會產生重複資料。
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:sku-mapping:read' FROM roles WHERE key IN ('admin', 'manager');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:sku-mapping:write' FROM roles WHERE key IN ('admin', 'manager');
--> statement-breakpoint
-- 舊的 wms:inventory:write 不移除：它本來就還有別的用途（改商品資料）。
--> statement-breakpoint
-- 自訂角色與個人授權也要跟著搬：它們當初是靠 wms:inventory:write 才進得了這一頁，
-- 不補的話升級之後那些人會直接失去它，而且畫面上看不出原因。
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT DISTINCT role_id, 'tools:sku-mapping:read' FROM role_permissions WHERE permission = 'wms:inventory:write';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT DISTINCT role_id, 'tools:sku-mapping:write' FROM role_permissions WHERE permission = 'wms:inventory:write';
--> statement-breakpoint
INSERT OR IGNORE INTO user_permissions (user_id, permission)
SELECT DISTINCT user_id, 'tools:sku-mapping:read' FROM user_permissions WHERE permission = 'wms:inventory:write';
--> statement-breakpoint
INSERT OR IGNORE INTO user_permissions (user_id, permission)
SELECT DISTINCT user_id, 'tools:sku-mapping:write' FROM user_permissions WHERE permission = 'wms:inventory:write';
