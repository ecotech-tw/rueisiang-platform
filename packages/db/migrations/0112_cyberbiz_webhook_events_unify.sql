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
  legacy.id,
  legacy.topic,
  CASE
    -- migration 期間無法知道舊 Worker 是否還會繼續處理這筆，不能把
    -- processing 帶進 target，否則新 cron 永遠不會補跑它。
    WHEN legacy.status IN ('processed', 'ignored', 'failed') THEN legacy.status
    ELSE 'failed'
  END,
  'product',
  legacy.variant_id,
  json_object(
    'product_id', legacy.product_id,
    'variant_id', legacy.variant_id,
    'sku', legacy.sku,
    'inventory_quantity', legacy.quantity
  ),
  CASE WHEN trim(legacy.result) = '' THEN '{}' ELSE legacy.result END,
  CASE
    WHEN legacy.status NOT IN ('processed', 'ignored', 'failed') AND trim(legacy.last_error) = ''
      THEN 'legacy webhook 在 migration 時仍是 processing，已改列 failed'
    ELSE NULLIF(legacy.last_error, '')
  END,
  legacy.received_at,
  legacy.processed_at,
  legacy.updated_at,
  legacy.attempts
FROM cyberbiz_product_webhooks legacy
WHERE NOT EXISTS (
  SELECT 1
  FROM cyberbiz_webhook_events existing
  WHERE existing.id = legacy.id
);--> statement-breakpoint
-- 同一個 dedup id 已被 customer event 佔用時，不可因 UNIQUE collision 讓整支
-- data migration rollback；保存衝突摘要，後續可依 legacy payload 重建人工處理。
INSERT INTO activity_events (
  id,
  entity_type,
  entity_id,
  entity_label,
  event_type,
  summary,
  payload_json,
  source,
  status,
  error,
  created_at
)
SELECT
  'migration:0112:webhook-conflict:' || legacy.id,
  'cyberbiz_webhook',
  legacy.id,
  legacy.topic,
  'cyberbiz_webhook_migration_conflict',
  'legacy product webhook 與既有 unified event 使用相同 dedup id，未覆寫既有事件',
  json_object(
    'topic', legacy.topic,
    'product_id', legacy.product_id,
    'variant_id', legacy.variant_id,
    'sku', legacy.sku,
    'inventory_quantity', legacy.quantity,
    'legacy_result', legacy.result
  ),
  'cyberbiz',
  'failed',
  'cyberbiz_webhook_events 已存在相同 id',
  legacy.received_at
FROM cyberbiz_product_webhooks legacy
WHERE EXISTS (
  SELECT 1
  FROM cyberbiz_webhook_events existing
  WHERE existing.id = legacy.id
);
--> statement-breakpoint
-- 0114 由 drizzle-kit 產生 DROP；資料搬移與 schema cutover 分開，避免
-- future generate 把 data migration 當成 schema snapshot。
