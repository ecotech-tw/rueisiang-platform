/* 品項主檔與通路對應已從 WMS 庫存作業拆出獨立權限。 */
INSERT OR IGNORE INTO permissions (permission) VALUES
  ('items:item:read'),
  ('items:item:write'),
  ('items:category:read'),
  ('items:category:write'),
  ('wms:mapping:read'),
  ('wms:mapping:write');

/* 既有角色保留原本可以做的事；自訂角色不應因權限鍵改名而突然失去入口。 */
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT role_id, 'items:item:read' FROM role_permission_grants WHERE permission = 'wms:inventory:read';
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT role_id, 'items:item:write' FROM role_permission_grants WHERE permission = 'wms:inventory:write';
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT role_id, 'items:category:read' FROM role_permission_grants WHERE permission = 'wms:inventory:read';
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT role_id, 'items:category:write' FROM role_permission_grants WHERE permission = 'wms:category:write';
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT role_id, 'wms:mapping:read' FROM role_permission_grants WHERE permission = 'tools:sku-mapping:read';
INSERT OR IGNORE INTO role_permission_grants (role_id, permission)
SELECT role_id, 'wms:mapping:write' FROM role_permission_grants WHERE permission = 'tools:sku-mapping:write';

INSERT OR IGNORE INTO user_permission_grants (user_id, permission)
SELECT user_id, 'items:item:read' FROM user_permission_grants WHERE permission = 'wms:inventory:read';
INSERT OR IGNORE INTO user_permission_grants (user_id, permission)
SELECT user_id, 'items:item:write' FROM user_permission_grants WHERE permission = 'wms:inventory:write';
INSERT OR IGNORE INTO user_permission_grants (user_id, permission)
SELECT user_id, 'items:category:read' FROM user_permission_grants WHERE permission = 'wms:inventory:read';
INSERT OR IGNORE INTO user_permission_grants (user_id, permission)
SELECT user_id, 'items:category:write' FROM user_permission_grants WHERE permission = 'wms:category:write';
INSERT OR IGNORE INTO user_permission_grants (user_id, permission)
SELECT user_id, 'wms:mapping:read' FROM user_permission_grants WHERE permission = 'tools:sku-mapping:read';
INSERT OR IGNORE INTO user_permission_grants (user_id, permission)
SELECT user_id, 'wms:mapping:write' FROM user_permission_grants WHERE permission = 'tools:sku-mapping:write';

/* 新鍵已完成回填後刪掉舊鍵，避免權限管理頁出現程式已不再使用的幽靈授權。 */
DELETE FROM role_permission_grants WHERE permission IN ('tools:sku-mapping:read', 'tools:sku-mapping:write');
DELETE FROM user_permission_grants WHERE permission IN ('tools:sku-mapping:read', 'tools:sku-mapping:write');
