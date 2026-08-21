-- 資料修正：初次部署的 bootstrap 管理員只會先拿到三個 admin:* 權限，
-- 但 admin 系統角色在程式碼裡代表所有模組的完整權限。補齊既有的 admin 角色，
-- 讓已完成 bootstrap、尚未按「重新同步」的正式環境也能正常使用全部平台功能。
--
-- 這支 migration 刻意只補不刪，且用 INSERT OR IGNORE，重跑不會重複插入。
-- 之後權限目錄若有變更，仍由 /api/admin/roles/sync 以 permissions.ts 為準。
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission`)
SELECT `roles`.`id`, `admin_permissions`.`permission`
FROM `roles`
CROSS JOIN (
  SELECT 'crm:customer:read' AS `permission`
  UNION ALL SELECT 'crm:customer:write'
  UNION ALL SELECT 'crm:customer:block'
  UNION ALL SELECT 'crm:tag:read'
  UNION ALL SELECT 'crm:tag:write'
  UNION ALL SELECT 'crm:view:write'
  UNION ALL SELECT 'crm:activity:read'
  UNION ALL SELECT 'crm:sync:read'
  UNION ALL SELECT 'crm:sync:trigger'
  UNION ALL SELECT 'wms:map:read'
  UNION ALL SELECT 'wms:map:write'
  UNION ALL SELECT 'wms:inventory:read'
  UNION ALL SELECT 'wms:inventory:write'
  UNION ALL SELECT 'wms:inventory:count'
  UNION ALL SELECT 'wms:category:write'
  UNION ALL SELECT 'wms:activity:read'
  UNION ALL SELECT 'wms:sync:trigger'
  UNION ALL SELECT 'tools:payout:run'
  UNION ALL SELECT 'tools:payout:config'
  UNION ALL SELECT 'assistant:sandbox:read'
  UNION ALL SELECT 'assistant:sandbox:write'
  UNION ALL SELECT 'assistant:settings:read'
  UNION ALL SELECT 'assistant:settings:write'
  UNION ALL SELECT 'assistant:line:read'
  UNION ALL SELECT 'assistant:line:write'
  UNION ALL SELECT 'admin:user:read'
  UNION ALL SELECT 'admin:user:write'
  UNION ALL SELECT 'admin:role:write'
) AS `admin_permissions`
WHERE `roles`.`key` = 'admin'
  AND `roles`.`is_system` = 1;
