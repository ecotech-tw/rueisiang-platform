-- 預設政策調整：目前平台內建的唯讀工具，預設全部可在 Sandbox 與 LINE 使用。
--
-- 只把系統／migration 建立的 development 狀態升級；管理者明確改過的 enabled、development
-- 或 disabled 都保留，避免部署時覆蓋人工設定。
INSERT OR IGNORE INTO `assistant_tool_configs` (`key`, `status`, `updated_by`)
VALUES
  ('weather_open_meteo', 'enabled', 'migration:0033'),
  ('wms_list_inventory', 'enabled', 'migration:0033'),
  ('wms_search_warehouse', 'enabled', 'migration:0033'),
  ('wms_get_inventory_item', 'enabled', 'migration:0033'),
  ('wms_list_low_stock_items', 'enabled', 'migration:0033'),
  ('wms_get_activity', 'enabled', 'migration:0033'),
  ('crm_search_customers', 'enabled', 'migration:0033'),
  ('crm_get_customer', 'enabled', 'migration:0033'),
  ('crm_get_orders', 'enabled', 'migration:0033');

UPDATE `assistant_tool_configs`
SET `status` = 'enabled',
    `updated_at` = CURRENT_TIMESTAMP
WHERE `status` = 'development'
  AND (`updated_by` = 'system' OR `updated_by` LIKE 'migration:%');

-- 不修改既有 channel 的工具白名單。
-- 管理者可能已經刻意收回某個工具；目前資料表沒有保留「曾經授權後被收回」的 tombstone，
-- 因此 migration 無法安全區分「尚未補齊」與「刻意移除」，不能用 CROSS JOIN 重新插入 grant。
-- 新建立的 channel 由 ensureAssistantLineChannel 套用預設工具；既有 channel 若要增加工具，
-- 由管理者在後台明確儲存工具設定。
