-- 商品 webhook 與會員 webhook 共用 cyberbiz_webhook_events。
-- 舊商品表沒有保存原始 payload，只能用既有欄位重建可補跑的最小 payload；
-- 0112 之後新收到的事件會保存完整 raw body。
INSERT INTO cyberbiz_webhook_events (
  id,
  topic,
  status,
  entity_type,
  external_entity_id,
  payload_json,
  result_json,
  last_error,
  received_at,
  processed_at,
  updated_at,
  attempts
)
SELECT
  id,
  topic,
  CASE
    WHEN status IN ('processing', 'processed', 'ignored', 'failed') THEN status
    ELSE 'failed'
  END,
  'product',
  variant_id,
  json_object(
    'product_id', product_id,
    'variant_id', variant_id,
    'sku', sku,
    'inventory_quantity', quantity
  ),
  CASE WHEN trim(result) = '' THEN '{}' ELSE result END,
  NULLIF(last_error, ''),
  received_at,
  processed_at,
  updated_at,
  attempts
FROM cyberbiz_product_webhooks;--> statement-breakpoint

DROP TABLE cyberbiz_product_webhooks;
