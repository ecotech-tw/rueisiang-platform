-- wms_items 與 cyberbiz_products 都以 items.id 為身分，舊的 link 表不再是必要的關聯。
-- 只有 company mapping 能進入 WMS target；門市 mapping 沒有 target scope 欄位，
-- 會在下面留下 ignored activity，不能被靜默當成公司倉同步。
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
  '',
  '',
  1,
  '{}',
  NULL,
  CASE
    WHEN legacy.sync_status IN ('synced', 'failed') THEN legacy.sync_status
    ELSE 'failed'
  END,
  COALESCE(legacy.last_synced_at, CURRENT_TIMESTAMP)
FROM wms_cyberbiz_links legacy
WHERE legacy.warehouse_scope = 'company'
  -- 既有 target identity 不可被 legacy mapping 改寫；另外也不能撞到另一個
  -- item 的 external unique key。兩種情況都由下面的 audit 留下待人工 reconcile。
  AND NOT EXISTS (
    SELECT 1
    FROM cyberbiz_products existing_item
    WHERE existing_item.item_id = legacy.wms_item_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM cyberbiz_products occupied
    WHERE occupied.cyberbiz_product_id = legacy.cyberbiz_product_id
      AND occupied.cyberbiz_variant_id = legacy.cyberbiz_variant_id
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- external identity 已被另一筆 target item 佔用時，不可硬塞進 target；保留可追查的
-- failed audit，讓人工 reconcile 後再建立正確 mapping。
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
  'migration:0113:wms-cyberbiz:collision:' || legacy.id,
  'item',
  legacy.wms_item_id,
  item.sku || ' ' || item.name,
  'cyberbiz_link_not_migrated',
  'CYBERBIZ external identity 與既有 target mapping 衝突，mapping 未搬移',
  json_object(
    'cyberbiz_product_id', legacy.cyberbiz_product_id,
    'cyberbiz_variant_id', legacy.cyberbiz_variant_id,
    'legacy_link_id', legacy.id
  ),
  'cyberbiz_sync',
  'failed',
  'target cyberbiz_products 已存在衝突的 mapping',
  legacy.updated_at
FROM wms_cyberbiz_links legacy
JOIN items item ON item.id = legacy.wms_item_id
WHERE legacy.warehouse_scope = 'company'
  AND (
    EXISTS (
      SELECT 1
      FROM cyberbiz_products occupied
      WHERE occupied.cyberbiz_product_id = legacy.cyberbiz_product_id
        AND occupied.cyberbiz_variant_id = legacy.cyberbiz_variant_id
        AND occupied.item_id <> legacy.wms_item_id
    )
    OR EXISTS (
      SELECT 1
      FROM cyberbiz_products existing_item
      WHERE existing_item.item_id = legacy.wms_item_id
        AND (
          existing_item.cyberbiz_product_id <> legacy.cyberbiz_product_id
          OR existing_item.cyberbiz_variant_id <> legacy.cyberbiz_variant_id
        )
    )
  );
--> statement-breakpoint
-- 保留舊 link 的最後一次成功同步數量與時間。target 沒有重複的 quantity state，
-- 所以用 activity history 保存，而不是把一份會過期的數字塞進商品鏡像。
INSERT INTO activity_events (
  id,
  entity_type,
  entity_id,
  entity_label,
  event_type,
  summary,
  field,
  new_value,
  payload_json,
  source,
  status,
  created_at
)
SELECT
  'migration:0113:wms-cyberbiz:success:' || legacy.id,
  'item',
  legacy.wms_item_id,
  item.sku || ' ' || item.name,
  'cyberbiz_synced',
  '搬移前最後一次 CYBERBIZ 庫存同步',
  'quantity',
  CASE WHEN legacy.last_synced_quantity IS NULL THEN NULL ELSE CAST(legacy.last_synced_quantity AS TEXT) END,
  '{}',
  'cyberbiz_sync',
  'succeeded',
  COALESCE(legacy.last_synced_at, legacy.updated_at)
FROM wms_cyberbiz_links legacy
JOIN items item ON item.id = legacy.wms_item_id
WHERE legacy.warehouse_scope = 'company'
  AND legacy.sync_status = 'synced'
  AND (legacy.last_synced_quantity IS NOT NULL OR legacy.last_synced_at IS NOT NULL);
--> statement-breakpoint
-- 失敗狀態與錯誤原因也要保留；即使舊資料沒有 error 欄位內容，failed 仍不可
-- 在 migration 後被誤顯示成 synced。
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
  'migration:0113:wms-cyberbiz:failed:' || legacy.id,
  'item',
  legacy.wms_item_id,
  item.sku || ' ' || item.name,
  'cyberbiz_sync_failed',
  '搬移前的 CYBERBIZ 同步失敗',
  '{}',
  'cyberbiz_sync',
  'failed',
  COALESCE(NULLIF(trim(legacy.last_error), ''), '舊 link 的同步狀態為 failed'),
  legacy.updated_at
FROM wms_cyberbiz_links legacy
JOIN items item ON item.id = legacy.wms_item_id
WHERE legacy.warehouse_scope = 'company'
  AND (legacy.sync_status = 'failed' OR trim(legacy.last_error) <> '');
--> statement-breakpoint
-- target 沒有 warehouse_scope；這些 mapping 不可繼續被當成公司倉同步，但要留下可
-- 追查的紀錄，避免 DROP legacy table 後完全失去資料線索。
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
  'migration:0113:wms-cyberbiz:ignored:' || legacy.id,
  'item',
  legacy.wms_item_id,
  item.sku || ' ' || item.name,
  'cyberbiz_link_not_migrated',
  '非公司倉 CYBERBIZ mapping 未搬移',
  json_object('warehouse_scope', legacy.warehouse_scope, 'pos_shop_id', legacy.pos_shop_id),
  'cyberbiz_sync',
  'ignored',
  'target WMS 只支援 company warehouse',
  legacy.updated_at
FROM wms_cyberbiz_links legacy
JOIN items item ON item.id = legacy.wms_item_id
WHERE COALESCE(legacy.warehouse_scope, '') <> 'company';
--> statement-breakpoint
-- 0114 由 drizzle-kit 產生 DROP，讓這支只負責資料搬移與歷史保留。
