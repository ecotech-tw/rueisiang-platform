-- 同一個 SKU 在 items 裡有兩筆：一筆 source='cyberbiz'（sync 建的鏡像），
-- 一筆 source='custom'（0081 從 custom_report_products、0088 從 report_manual_sales_monthly
-- 回填出來的）。那兩支 backfill 只看自己的來源，沒有先問「這個 SKU 是不是已經有品項了」，
-- 所以同一個商品被建成兩個 item。
--
-- 舊索引是 UNIQUE(source, sku)，這種重複合法，所以沒有人擋得住。下一支 migration 會把它
-- 改成 UNIQUE(sku)；在那之前必須先把重複的併掉，否則索引建不起來。
--
-- 併的方向是「留 cyberbiz、砍 custom」：cyberbiz 那一筆有 cyberbiz_products 延伸資料，
-- 而且 sync 會一直把它寫回來，砍掉只會下次同步又長出來。
--
-- 所有的 UPDATE 都是普通 UPDATE，不用 OR IGNORE：真的撞到主鍵時要整支 migration 中止，
-- 不能安靜地把資料丟掉。

-- 分類是 custom 那一筆才有的資訊（sync 不管分類），併之前先搬過去。
UPDATE items AS target
SET category_id = (
  SELECT source_item.category_id FROM items AS source_item
  WHERE source_item.sku = target.sku AND source_item.source = 'custom'
    AND source_item.category_id IS NOT NULL
)
WHERE target.source = 'cyberbiz'
  AND target.category_id IS NULL
  AND EXISTS (
    SELECT 1 FROM items AS source_item
    WHERE source_item.sku = target.sku AND source_item.source = 'custom'
      AND source_item.category_id IS NOT NULL
  );

-- 以下四張表是 items.id 的全部外鍵來源（cyberbiz_products 不算：它只會指到 cyberbiz 那一筆）。
UPDATE report_item_sales_monthly AS row_to_move
SET item_id = (
  SELECT keeper.id FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.item_id AND duplicate.source = 'custom'
)
WHERE EXISTS (
  SELECT 1 FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.item_id AND duplicate.source = 'custom'
);

UPDATE report_external_products AS row_to_move
SET item_id = (
  SELECT keeper.id FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.item_id AND duplicate.source = 'custom'
)
WHERE EXISTS (
  SELECT 1 FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.item_id AND duplicate.source = 'custom'
);

UPDATE wms_items AS row_to_move
SET item_id = (
  SELECT keeper.id FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.item_id AND duplicate.source = 'custom'
)
WHERE EXISTS (
  SELECT 1 FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.item_id AND duplicate.source = 'custom'
);

-- item_components 目前是空的，但還是要搬：parent_item_id 是 ON DELETE CASCADE，
-- 沒搬就直接刪 items 會把整組 BOM 一起靜靜刪掉。
UPDATE item_components AS row_to_move
SET parent_item_id = (
  SELECT keeper.id FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.parent_item_id AND duplicate.source = 'custom'
)
WHERE EXISTS (
  SELECT 1 FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.parent_item_id AND duplicate.source = 'custom'
);

UPDATE item_components AS row_to_move
SET component_item_id = (
  SELECT keeper.id FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.component_item_id AND duplicate.source = 'custom'
)
WHERE EXISTS (
  SELECT 1 FROM items AS duplicate
  JOIN items AS keeper ON keeper.sku = duplicate.sku AND keeper.source = 'cyberbiz'
  WHERE duplicate.id = row_to_move.component_item_id AND duplicate.source = 'custom'
);

DELETE FROM items
WHERE source = 'custom'
  AND EXISTS (
    SELECT 1 FROM items AS keeper
    WHERE keeper.sku = items.sku AND keeper.source = 'cyberbiz'
  );
