-- 將 activity_events 的舊 entity_type 對齊 target contract
-- 只更新分類值，不改 entity_id 或其他稽核欄位
UPDATE activity_events
SET entity_type = CASE entity_type
  WHEN 'inventory_item' THEN 'item'
  WHEN 'report_product_category' THEN 'item_category'
  WHEN 'zone' THEN 'wms_zone'
  WHEN 'warehouse_category' THEN 'wms_category'
  ELSE entity_type
END
WHERE entity_type IN ('inventory_item', 'report_product_category', 'zone', 'warehouse_category');
