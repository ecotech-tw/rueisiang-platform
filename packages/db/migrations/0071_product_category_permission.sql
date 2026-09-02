-- Replace the old SKU-tag permissions with the product-category permissions.
-- Keep this migration idempotent so it is safe to re-run during bootstrap.
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:product-category:read' FROM roles WHERE key = 'admin';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:product-category:write' FROM roles WHERE key = 'admin';
--> statement-breakpoint
DELETE FROM role_permissions WHERE permission IN ('tools:sku-tag:read', 'tools:sku-tag:write');
--> statement-breakpoint
DELETE FROM user_permissions WHERE permission IN ('tools:sku-tag:read', 'tools:sku-tag:write');
