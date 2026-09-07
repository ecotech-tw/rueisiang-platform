-- manual:store:* 是人工補上的退租店，不是 runner 可執行的 CYBERBIZ POS 店。
-- 舊程式曾讓它們沿用 cyberbiz source_type；先校正，避免下面搬 payout_stores 時
-- 被同名 manual scope 擋住 idx_scopes_source_normalized。
UPDATE `scopes`
SET `source_type` = 'manual', `updated_at` = CURRENT_TIMESTAMP
WHERE `id` LIKE 'manual:%';--> statement-breakpoint

-- payout_stores 是 scopes 的舊設定來源；刪表前先把 0096 之後可能改過的
-- Drive 目標、排序與啟用狀態同步回 scopes。之後 D1 的唯一來源就是 scopes。
UPDATE `scopes`
SET
  `drive_folder_url` = (
    SELECT p.`drive_folder_url` FROM `payout_stores` p
    WHERE lower(replace(replace(replace(p.`name`, ' ', ''), char(9), ''), char(10), '')) = `scopes`.`normalized_name`
    LIMIT 1
  ),
  `drive_folder_name` = (
    SELECT p.`drive_folder_name` FROM `payout_stores` p
    WHERE lower(replace(replace(replace(p.`name`, ' ', ''), char(9), ''), char(10), '')) = `scopes`.`normalized_name`
    LIMIT 1
  ),
  `sort_order` = (
    SELECT p.`sort_order` FROM `payout_stores` p
    WHERE lower(replace(replace(replace(p.`name`, ' ', ''), char(9), ''), char(10), '')) = `scopes`.`normalized_name`
    LIMIT 1
  ),
  `active` = (
    SELECT CASE WHEN p.`enabled` THEN 1 ELSE 0 END FROM `payout_stores` p
    WHERE lower(replace(replace(replace(p.`name`, ' ', ''), char(9), ''), char(10), '')) = `scopes`.`normalized_name`
    LIMIT 1
  ),
  `updated_at` = CURRENT_TIMESTAMP
WHERE `source_type` = 'cyberbiz'
  AND `scope_kind` = 'store'
  AND `id` NOT LIKE 'manual:%'
  AND EXISTS (
    SELECT 1 FROM `payout_stores` p
    WHERE lower(replace(replace(replace(p.`name`, ' ', ''), char(9), ''), char(10), '')) = `scopes`.`normalized_name`
  );--> statement-breakpoint

-- 只有 payout_stores 有、scopes 還沒有的店也要搬過去。舊 payout_stores.id 多半是
-- uuid，不能直接當公司報表 scope；加上 cyberbiz:store: 前綴後仍是穩定 ID，且符合
-- isCompanyReportStoreScopeId 接受的格式。
INSERT OR IGNORE INTO `scopes` (
  `id`, `source_type`, `scope_kind`, `name`, `normalized_name`,
  `drive_folder_url`, `drive_folder_name`, `sort_order`, `active`, `created_at`, `updated_at`
)
SELECT
  CASE
    WHEN p.`id` LIKE '%:store:%' OR p.`id` LIKE 'store-%' THEN p.`id`
    ELSE 'cyberbiz:store:' || p.`id`
  END,
  'cyberbiz',
  'store',
  p.`name`,
  lower(replace(replace(replace(p.`name`, ' ', ''), char(9), ''), char(10), '')),
  p.`drive_folder_url`,
  p.`drive_folder_name`,
  p.`sort_order`,
  CASE WHEN p.`enabled` THEN 1 ELSE 0 END,
  p.`created_at`,
  p.`updated_at`
FROM `payout_stores` p
WHERE NOT EXISTS (
  SELECT 1 FROM `scopes` s
  WHERE s.`source_type` = 'cyberbiz'
    AND s.`scope_kind` = 'store'
    AND s.`id` NOT LIKE 'manual:%'
    AND s.`normalized_name` = lower(replace(replace(replace(p.`name`, ' ', ''), char(9), ''), char(10), ''))
);--> statement-breakpoint

DROP TABLE `payout_stores`;
