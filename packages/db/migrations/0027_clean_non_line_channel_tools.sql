-- 資料清理：移除 LINE channel 白名單裡不支援 LINE 的工具。
--
-- 0025 的第一版把所有已啟用的工具都補進白名單，包含 surfaces 只有 ["sandbox", "mcp"]
-- 的 crm_get_customer 與 crm_get_orders。那個版本在合併前就修掉了，正式環境不會有；
-- 但任何在 review 期間拉過該分支、跑過 migration 的機器都留著這幾列，而 migration 是
-- 以檔名記錄的，修好的 0025 不會再跑一次。
--
-- 留著的後果不是「多給了權限」——執行時本來就會被 surface 濾掉——而是設定頁把它們
-- 顯示成「已授權」，使用者原封不動按儲存卻被 PUT /line/tools 的檢查退回，變成怎麼存
-- 都失敗，而且看不出原因。
--
-- 這份清單是這支 migration 執行當下「支援 LINE」的工具；surfaces 寫在程式碼裡，SQL
-- 讀不到。migration 是某個時間點的快照，本來就不該跟著之後的程式一起改。
DELETE FROM `assistant_channel_tools`
WHERE `tool_key` NOT IN (
  'weather_open_meteo',
  'wms_list_inventory',
  'wms_search_warehouse',
  'wms_get_inventory_item',
  'wms_list_low_stock_items',
  'wms_get_activity',
  'crm_search_customers'
);
