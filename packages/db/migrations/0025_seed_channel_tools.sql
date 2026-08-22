-- 資料搬移：把「目前已啟用的工具」寫成既有 channel 的白名單。
--
-- 沒有這一段的話，0024 部署完的那一刻小香會突然一個工具都不能用——新的授權來源是
-- assistant_channel_tools，而它是空的。行為要無縫接上：換權限模型不該讓線上的 bot
-- 安靜地變笨。
--
-- 只補 status = 'enabled' 的。'development' 是「只能在 Sandbox 驗證」，本來就不該
-- 出現在 LINE，補進來等於偷偷放行。
--
-- 另外只補「支援 LINE surface」的工具。surfaces 寫在程式碼（packages/tools）裡，SQL 讀
-- 不到，所以這裡把當下的清單抄成常數——migration 是某個時間點的快照，本來就不該隨程式
-- 一起漂移。不抄的話，crm_get_customer 與 crm_get_orders 這種 sandbox-only 的工具會被
-- 寫進 LINE 白名單：執行時雖然會被濾掉，但設定頁會顯示成「已授權」，讓後台看到的授權
-- 狀態跟實際能用的工具對不上。
--
-- 之後新開的 channel 一律從空白開始（沒有列 = 不給）；這支只服務「換模型之前就存在」
-- 的那一個 channel。用 INSERT OR IGNORE ＋ 唯一索引保護，重跑不會插出重複。
INSERT OR IGNORE INTO `assistant_channel_tools` (`id`, `channel_key`, `tool_key`, `created_by`)
SELECT
  lower(hex(randomblob(16))),
  `c`.`channel_key`,
  `t`.`key`,
  'migration:0025'
FROM `assistant_line_channels` AS `c`
CROSS JOIN `assistant_tool_configs` AS `t`
WHERE `t`.`status` = 'enabled'
  AND `t`.`key` IN (
    'weather_open_meteo',
    'wms_list_inventory',
    'wms_search_warehouse',
    'wms_get_inventory_item',
    'wms_list_low_stock_items',
    'wms_get_activity',
    'crm_search_customers'
  );
