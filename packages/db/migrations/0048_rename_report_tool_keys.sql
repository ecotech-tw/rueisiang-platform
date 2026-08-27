-- 報表工具改為通路中立名稱；保留既有 Sandbox 設定、LINE channel 白名單與對話綁定。
INSERT OR IGNORE INTO assistant_tool_configs (key, status, updated_by, updated_at)
SELECT 'query_sales_report', status, updated_by, updated_at
FROM assistant_tool_configs
WHERE key = 'cyberbiz_query_sales_report';
UPDATE assistant_tool_configs
SET status = (SELECT status FROM assistant_tool_configs WHERE key = 'cyberbiz_query_sales_report'),
    updated_by = (SELECT updated_by FROM assistant_tool_configs WHERE key = 'cyberbiz_query_sales_report'),
    updated_at = (SELECT updated_at FROM assistant_tool_configs WHERE key = 'cyberbiz_query_sales_report')
WHERE key = 'query_sales_report'
  AND EXISTS (SELECT 1 FROM assistant_tool_configs WHERE key = 'cyberbiz_query_sales_report');
DELETE FROM assistant_tool_configs WHERE key = 'cyberbiz_query_sales_report';

INSERT OR IGNORE INTO assistant_tool_configs (key, status, updated_by, updated_at)
SELECT 'query_payout_report', status, updated_by, updated_at
FROM assistant_tool_configs
WHERE key = 'cyberbiz_query_payout_report';
UPDATE assistant_tool_configs
SET status = (SELECT status FROM assistant_tool_configs WHERE key = 'cyberbiz_query_payout_report'),
    updated_by = (SELECT updated_by FROM assistant_tool_configs WHERE key = 'cyberbiz_query_payout_report'),
    updated_at = (SELECT updated_at FROM assistant_tool_configs WHERE key = 'cyberbiz_query_payout_report')
WHERE key = 'query_payout_report'
  AND EXISTS (SELECT 1 FROM assistant_tool_configs WHERE key = 'cyberbiz_query_payout_report');
DELETE FROM assistant_tool_configs WHERE key = 'cyberbiz_query_payout_report';

-- 若同一 channel 已有新舊兩列，先把 custom chat 綁定移到新列，避免唯一鍵衝突。
DELETE FROM assistant_chat_tools
WHERE channel_tool_id IN (
  SELECT legacy.id FROM assistant_channel_tools AS legacy
  WHERE legacy.tool_key = 'cyberbiz_query_sales_report'
)
  AND EXISTS (
    SELECT 1
    FROM assistant_chat_tools AS current_chat
    INNER JOIN assistant_channel_tools AS current_tool ON current_tool.id = current_chat.channel_tool_id
    INNER JOIN assistant_channel_tools AS legacy ON legacy.id = assistant_chat_tools.channel_tool_id
    WHERE current_chat.group_id = assistant_chat_tools.group_id
      AND current_tool.channel_key = legacy.channel_key
      AND current_tool.tool_key = 'query_sales_report'
  );
UPDATE assistant_chat_tools
SET channel_tool_id = (
  SELECT current_tool.id
  FROM assistant_channel_tools AS legacy
  INNER JOIN assistant_channel_tools AS current_tool ON current_tool.channel_key = legacy.channel_key
  WHERE legacy.id = assistant_chat_tools.channel_tool_id
    AND legacy.tool_key = 'cyberbiz_query_sales_report'
    AND current_tool.tool_key = 'query_sales_report'
)
WHERE channel_tool_id IN (
  SELECT legacy.id FROM assistant_channel_tools AS legacy
  WHERE legacy.tool_key = 'cyberbiz_query_sales_report'
)
  AND EXISTS (
    SELECT 1
    FROM assistant_channel_tools AS legacy
    INNER JOIN assistant_channel_tools AS current_tool ON current_tool.channel_key = legacy.channel_key
    WHERE legacy.id = assistant_chat_tools.channel_tool_id
      AND current_tool.tool_key = 'query_sales_report'
  );
DELETE FROM assistant_channel_tools
WHERE tool_key = 'cyberbiz_query_sales_report'
  AND EXISTS (
    SELECT 1 FROM assistant_channel_tools AS current_tool
    WHERE current_tool.channel_key = assistant_channel_tools.channel_key
      AND current_tool.tool_key = 'query_sales_report'
  );
UPDATE assistant_channel_tools
SET tool_key = 'query_sales_report'
WHERE tool_key = 'cyberbiz_query_sales_report';

DELETE FROM assistant_chat_tools
WHERE channel_tool_id IN (
  SELECT legacy.id FROM assistant_channel_tools AS legacy
  WHERE legacy.tool_key = 'cyberbiz_query_payout_report'
)
  AND EXISTS (
    SELECT 1
    FROM assistant_chat_tools AS current_chat
    INNER JOIN assistant_channel_tools AS current_tool ON current_tool.id = current_chat.channel_tool_id
    INNER JOIN assistant_channel_tools AS legacy ON legacy.id = assistant_chat_tools.channel_tool_id
    WHERE current_chat.group_id = assistant_chat_tools.group_id
      AND current_tool.channel_key = legacy.channel_key
      AND current_tool.tool_key = 'query_payout_report'
  );
UPDATE assistant_chat_tools
SET channel_tool_id = (
  SELECT current_tool.id
  FROM assistant_channel_tools AS legacy
  INNER JOIN assistant_channel_tools AS current_tool ON current_tool.channel_key = legacy.channel_key
  WHERE legacy.id = assistant_chat_tools.channel_tool_id
    AND legacy.tool_key = 'cyberbiz_query_payout_report'
    AND current_tool.tool_key = 'query_payout_report'
)
WHERE channel_tool_id IN (
  SELECT legacy.id FROM assistant_channel_tools AS legacy
  WHERE legacy.tool_key = 'cyberbiz_query_payout_report'
)
  AND EXISTS (
    SELECT 1
    FROM assistant_channel_tools AS legacy
    INNER JOIN assistant_channel_tools AS current_tool ON current_tool.channel_key = legacy.channel_key
    WHERE legacy.id = assistant_chat_tools.channel_tool_id
      AND current_tool.tool_key = 'query_payout_report'
  );
DELETE FROM assistant_channel_tools
WHERE tool_key = 'cyberbiz_query_payout_report'
  AND EXISTS (
    SELECT 1 FROM assistant_channel_tools AS current_tool
    WHERE current_tool.channel_key = assistant_channel_tools.channel_key
      AND current_tool.tool_key = 'query_payout_report'
  );
UPDATE assistant_channel_tools
SET tool_key = 'query_payout_report'
WHERE tool_key = 'cyberbiz_query_payout_report';
