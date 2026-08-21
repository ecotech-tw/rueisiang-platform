-- 補上既有管理者使用 CYBERBIZ 訂單工具所需的唯讀權限。
-- 使用 INSERT OR IGNORE，讓重跑不會產生重複資料。
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission`)
SELECT `id`, 'crm:order:read'
FROM `roles`
WHERE `key` = 'admin'
  AND `is_system` = 1;

INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission`)
SELECT `id`, 'crm:order:read'
FROM `roles`
WHERE `key` = 'manager'
  AND `is_system` = 1;
