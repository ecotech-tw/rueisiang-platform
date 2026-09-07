-- 正式庫的唯讀驗證查詢。貼進「D1 查詢（唯讀）」workflow 的 sql 欄位執行。
--
-- 查詢結果是觀測值，不把會隨日常同步變動的資料量寫成硬編碼通過條件；
-- 需要比對歷史 parity 時，請對照已核准的 production backup 與 deploy 紀錄。
-- 本檔不得查詢或輸出客戶電話、Email 或其他個資。

SELECT '=== migrations ===' AS q;
SELECT id, name FROM d1_migrations ORDER BY id;

SELECT '=== 0095 CRM target cutover ===' AS q;
SELECT (SELECT COUNT(*) FROM crm_tags) AS tags,
       (SELECT COUNT(*) FROM crm_customer_tags) AS customer_tags,
       (SELECT COUNT(*) FROM crm_customers) AS customers;

-- 舊 CRM 欄位應已移除，結果應為 0 列。
SELECT name FROM pragma_table_info('crm_customers')
WHERE name IN ('source_channel', 'cyberbiz_tags_json', 'sync_error', 'last_webhook_at');

-- 標籤關聯不應指向不存在的客戶或標籤，結果應為 0。
SELECT COUNT(*) AS orphan_tag_links FROM crm_customer_tags t
WHERE NOT EXISTS (SELECT 1 FROM crm_customers c WHERE c.id = t.customer_id)
   OR NOT EXISTS (SELECT 1 FROM crm_tags g WHERE g.id = t.crm_tag_id);

SELECT '=== 0096 scopes merge ===' AS q;
SELECT source_type, scope_kind, COUNT(*) AS n FROM scopes GROUP BY 1, 2;

-- 同一個 normalized name 不應有多列，結果應為 0 列。
SELECT normalized_name, COUNT(*) AS n FROM scopes GROUP BY 1 HAVING n > 1;

SELECT COUNT(*) AS with_drive FROM scopes WHERE drive_folder_url <> '';

SELECT '=== 0111 payout stores removed ===' AS q;
-- 舊表應已移除，結果應為 0 列；CYBERBIZ 實體店別改由 scopes 承載。
SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payout_stores';
SELECT COUNT(*) AS runnable_cyberbiz_stores
FROM scopes
WHERE source_type = 'cyberbiz'
  AND scope_kind = 'store'
  AND id NOT LIKE 'manual:%';

SELECT '=== items ===' AS q;
-- SKU 是全平台唯一，結果應為 0 列。
SELECT sku, COUNT(*) AS n FROM items GROUP BY 1 HAVING n > 1;
SELECT source, kind, COUNT(*) AS n FROM items GROUP BY 1, 2;

SELECT '=== item_categories constraints ===' AS q;
-- 三個計數都應為 0。
SELECT (SELECT COUNT(*) FROM item_categories WHERE depth NOT IN (0, 1)) AS bad_depth,
       (SELECT COUNT(*) FROM item_categories WHERE (depth = 0) <> (parent_id IS NULL)) AS bad_parent,
       (SELECT COUNT(*) FROM item_categories c WHERE c.parent_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM item_categories p WHERE p.id = c.parent_id AND p.depth = c.parent_depth)) AS orphan;

SELECT '=== permission grants ===' AS q;
SELECT (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM user_role_assignments) AS role_assignments,
       (SELECT COUNT(*) FROM role_permission_grants) AS role_permission_grants,
       (SELECT COUNT(*) FROM user_permission_grants) AS user_permission_grants;

SELECT '=== 0097 webhook entity types ===' AS q;
SELECT entity_type, status, COUNT(*) AS n
FROM cyberbiz_webhook_events
GROUP BY 1, 2;

-- 商品 webhook 仍由 WMS 專用表處理；topic 可用來確認實際收到的事件種類，
-- 不輸出 payload 或外部個資。這是「已收到」的觀測，不等同於 CYBERBIZ 後台勾選設定。
SELECT topic, status, COUNT(*) AS n
FROM cyberbiz_product_webhooks
GROUP BY 1, 2;

SELECT '=== 0101 activity entity types ===' AS q;
SELECT entity_type, COUNT(*) AS n
FROM activity_events
GROUP BY 1
ORDER BY 1;

-- 舊 entity_type 應已全部改名，結果應為 0 列，不輸出 entity_id 或其他個資。
SELECT entity_type, COUNT(*) AS n
FROM activity_events
WHERE entity_type IN ('inventory_item', 'report_product_category', 'zone', 'warehouse_category')
GROUP BY 1;

SELECT '=== report parity observation ===' AS q;
-- Approved production-backup baseline (2026-09-03):
-- imported: 4,110 rows / net_quantity 186,529 / sales_amount 29,528,346
-- manual:     383 rows / net_quantity   5,663 / sales_amount  2,014,715
-- payout:   3,369 rows / payout_amount 45,874,851
-- Compare these values with the current output. A later intentional report import may
-- change the observation, but an unexplained difference requires investigation.
SELECT COUNT(*) AS rows, SUM(net_quantity) AS net_qty, SUM(sales_amount) AS amount
FROM report_item_sales_monthly WHERE record_origin = 'imported';
SELECT COUNT(*) AS rows, SUM(net_quantity) AS net_qty, SUM(sales_amount) AS amount
FROM report_item_sales_monthly WHERE record_origin = 'manual';
SELECT COUNT(*) AS rows, SUM(payout_amount) AS amount FROM report_payout_daily;

SELECT '=== foreign keys ===' AS q;
-- 結果應為 0 列。
PRAGMA foreign_key_check;
