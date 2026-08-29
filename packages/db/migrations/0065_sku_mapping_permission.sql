-- SKU 對應從倉儲移到營運工具，權限鍵值跟著換。既有的管理者與主管要補上新的兩個，
-- 否則升級之後那一頁會從側欄消失。重跑不會產生重複資料。
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:sku-mapping:read' FROM roles WHERE key IN ('admin', 'manager');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:sku-mapping:write' FROM roles WHERE key IN ('admin', 'manager');
--> statement-breakpoint
-- 直接授權給個人的舊鍵值不動：wms:inventory:write 本來就還有別的用途（改商品資料）。
