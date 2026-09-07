-- wms_items 與 cyberbiz_products 都以 items.id 為身分，舊的 link 表不再是必要的關聯。
-- 先把尚未進入商品鏡像的舊連結補進 cyberbiz_products，再移除重複的 link store。
INSERT INTO cyberbiz_products (
  item_id,
  cyberbiz_product_id,
  cyberbiz_variant_id,
  product_name,
  variant_name,
  published,
  raw_json,
  cyberbiz_updated_at,
  sync_status,
  synced_at
)
SELECT
  legacy.wms_item_id,
  legacy.cyberbiz_product_id,
  legacy.cyberbiz_variant_id,
  COALESCE(existing.product_name, ''),
  COALESCE(existing.variant_name, ''),
  COALESCE(existing.published, 1),
  COALESCE(existing.raw_json, '{}'),
  existing.cyberbiz_updated_at,
  COALESCE(existing.sync_status, 'synced'),
  COALESCE(existing.synced_at, CURRENT_TIMESTAMP)
FROM wms_cyberbiz_links legacy
LEFT JOIN cyberbiz_products existing ON existing.item_id = legacy.wms_item_id
ON CONFLICT(item_id) DO UPDATE SET
  cyberbiz_product_id = excluded.cyberbiz_product_id,
  cyberbiz_variant_id = excluded.cyberbiz_variant_id,
  synced_at = excluded.synced_at;
--> statement-breakpoint
-- 舊 link 的錯誤狀態沒有 target 欄位，轉成操作紀錄避免遺失最後一次失敗原因。
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
  'migration:0113:wms-cyberbiz:' || legacy.id,
  'item',
  legacy.wms_item_id,
  item.sku || ' ' || item.name,
  'cyberbiz_sync_failed',
  '搬移前的 CYBERBIZ 同步失敗',
  '{}',
  'cyberbiz_sync',
  'failed',
  legacy.last_error,
  legacy.updated_at
FROM wms_cyberbiz_links legacy
JOIN items item ON item.id = legacy.wms_item_id
WHERE trim(legacy.last_error) <> '';
--> statement-breakpoint
DROP TABLE wms_cyberbiz_links;
