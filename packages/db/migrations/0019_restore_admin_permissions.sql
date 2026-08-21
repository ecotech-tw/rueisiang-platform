-- 資料修正：初次部署的 bootstrap 管理員只會先拿到三個 admin:* 權限，
-- 但 admin 系統角色在程式碼裡代表所有模組的完整權限。補齊既有的 admin 角色，
-- 讓已完成 bootstrap、尚未按「重新同步」的正式環境也能正常使用全部平台功能。
--
-- 這支 migration 刻意只補不刪，且用 INSERT OR IGNORE，重跑不會重複插入。
-- 之後權限目錄若有變更，仍由 /api/admin/roles/sync 以 permissions.ts 為準。
WITH `admin_role` AS (
  SELECT `id`
  FROM `roles`
  WHERE `key` = 'admin'
    AND `is_system` = 1
),
`admin_permissions` (`permission`) AS (
  VALUES
    ('crm:customer:read'),
    ('crm:customer:write'),
    ('crm:customer:block'),
    ('crm:tag:read'),
    ('crm:tag:write'),
    ('crm:view:write'),
    ('crm:activity:read'),
    ('crm:sync:read'),
    ('crm:sync:trigger'),
    ('wms:map:read'),
    ('wms:map:write'),
    ('wms:inventory:read'),
    ('wms:inventory:write'),
    ('wms:inventory:count'),
    ('wms:category:write'),
    ('wms:activity:read'),
    ('wms:sync:trigger'),
    ('tools:payout:run'),
    ('tools:payout:config'),
    ('assistant:sandbox:read'),
    ('assistant:sandbox:write'),
    ('assistant:settings:read'),
    ('assistant:settings:write'),
    ('assistant:line:read'),
    ('assistant:line:write'),
    ('admin:user:read'),
    ('admin:user:write'),
    ('admin:role:write')
)
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission`)
SELECT `admin_role`.`id`, `admin_permissions`.`permission`
FROM `admin_role`
CROSS JOIN `admin_permissions`;
