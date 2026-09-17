-- 新增品項主檔查詢工具時，只回填原本已取得完整 LINE 唯讀工具集合的 channel。
-- 這讓既有「全選」頻道可以先解析 itemId，再查報表或 WMS；曾人工收回工具的頻道不自動擴權。
INSERT OR IGNORE INTO `assistant_tool_configs` (`key`, `status`, `updated_by`, `updated_at`)
VALUES ('list_items', 'enabled', 'migration:0158', CURRENT_TIMESTAMP);--> statement-breakpoint

INSERT OR IGNORE INTO `assistant_channel_tools` (`id`, `channel_key`, `tool_key`, `created_by`, `created_at`)
SELECT lower(hex(randomblob(16))), `c`.`channel_key`, 'list_items', 'migration:0158', CURRENT_TIMESTAMP
FROM `assistant_line_channels` AS `c`
WHERE (
  SELECT COUNT(DISTINCT `tool_key`)
  FROM `assistant_channel_tools`
  WHERE `channel_key` = `c`.`channel_key`
    AND `tool_key` IN (
      'weather_open_meteo',
      'wms_list_inventory',
      'wms_search_warehouse',
      'wms_get_inventory_item',
      'wms_list_low_stock_items',
      'wms_get_activity',
      'crm_search_customers',
      'crm_get_customer',
      'crm_get_orders',
      'list_report_scopes',
      'query_sales_report',
      'query_payout_report'
    )
) = 12;--> statement-breakpoint

-- custom 對話若原本就拿到完整的舊工具集合，視為「全選」而一併取得新工具；
-- 只拿到部分工具的對話維持原設定，仍須管理員明確調整。
INSERT OR IGNORE INTO `assistant_chat_tools` (`id`, `group_id`, `channel_tool_id`, `created_by`, `created_at`)
SELECT lower(hex(randomblob(16))), `g`.`id`, `new_tool`.`id`, 'migration:0158', CURRENT_TIMESTAMP
FROM `assistant_line_groups` AS `g`
INNER JOIN `assistant_channel_tools` AS `new_tool`
  ON `new_tool`.`channel_key` = `g`.`channel_key`
 AND `new_tool`.`tool_key` = 'list_items'
WHERE `g`.`tool_mode` = 'custom'
  AND (
    SELECT COUNT(DISTINCT `old_tool`.`tool_key`)
    FROM `assistant_chat_tools` AS `chat_tool`
    INNER JOIN `assistant_channel_tools` AS `old_tool`
      ON `old_tool`.`id` = `chat_tool`.`channel_tool_id`
    WHERE `chat_tool`.`group_id` = `g`.`id`
      AND `old_tool`.`tool_key` IN (
        'weather_open_meteo',
        'wms_list_inventory',
        'wms_search_warehouse',
        'wms_get_inventory_item',
        'wms_list_low_stock_items',
        'wms_get_activity',
        'crm_search_customers',
        'crm_get_customer',
        'crm_get_orders',
        'list_report_scopes',
        'query_sales_report',
        'query_payout_report'
      )
  ) = 12;
