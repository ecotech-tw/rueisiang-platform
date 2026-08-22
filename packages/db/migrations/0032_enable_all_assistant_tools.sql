-- 預設政策調整：目前平台內建的唯讀工具，預設全部可在 Sandbox 與 LINE 使用。
--
-- 只把系統／migration 建立的 development 狀態升級；管理者明確改過的 enabled、development
-- 或 disabled 都保留，避免部署時覆蓋人工設定。
INSERT OR IGNORE INTO `assistant_tool_configs` (`key`, `status`, `updated_by`)
VALUES
  ('weather_open_meteo', 'enabled', 'migration:0032'),
  ('wms_list_inventory', 'enabled', 'migration:0032'),
  ('wms_search_warehouse', 'enabled', 'migration:0032'),
  ('wms_get_inventory_item', 'enabled', 'migration:0032'),
  ('wms_list_low_stock_items', 'enabled', 'migration:0032'),
  ('wms_get_activity', 'enabled', 'migration:0032'),
  ('crm_search_customers', 'enabled', 'migration:0032'),
  ('crm_get_customer', 'enabled', 'migration:0032'),
  ('crm_get_orders', 'enabled', 'migration:0032');

UPDATE `assistant_tool_configs`
SET `status` = 'enabled',
    `updated_at` = CURRENT_TIMESTAMP
WHERE `status` = 'development'
  AND (`updated_by` = 'system' OR `updated_by` LIKE 'migration:%');

-- 既有 LINE channel 原本只留下部分工具；補齊目前所有 LINE surface 工具。
-- 這是本次「預設全開」政策的一次性資料修復，之後管理者仍可從後台收回個別工具。
WITH `default_tools`(`tool_key`) AS (
  VALUES
    ('weather_open_meteo'),
    ('wms_list_inventory'),
    ('wms_search_warehouse'),
    ('wms_get_inventory_item'),
    ('wms_list_low_stock_items'),
    ('wms_get_activity'),
    ('crm_search_customers'),
    ('crm_get_customer'),
    ('crm_get_orders')
)
INSERT OR IGNORE INTO `assistant_channel_tools` (`id`, `channel_key`, `tool_key`, `created_by`)
SELECT
  lower(hex(randomblob(16))),
  `channel`.`channel_key`,
  `tool`.`tool_key`,
  'migration:0032'
FROM `assistant_line_channels` AS `channel`
CROSS JOIN `default_tools` AS `tool`;
