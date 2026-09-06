-- 搬移之後對正式庫的驗證查詢。全部唯讀，貼進「D1 查詢（唯讀）」workflow 的
-- sql 欄位執行（Actions → D1 查詢（唯讀）→ Run workflow）。
--
-- 右邊的期望值是在 2026-09-03 的正式庫備份上重播 0073→0096 得到的。
-- 對不上就代表正式庫跟備份重播的結果分岔了，那是要查的事。

SELECT '=== 0095 CRM cutover ===' AS q;
-- 期望：crm_tags 17、crm_customer_tags 11363
SELECT (SELECT COUNT(*) FROM crm_tags) AS tags,
       (SELECT COUNT(*) FROM crm_customer_tags) AS customer_tags,
       (SELECT COUNT(*) FROM crm_customers) AS customers;

-- 期望：0 列。這四欄應該已經被 0095 拿掉了
SELECT name FROM pragma_table_info('crm_customers')
WHERE name IN ('source_channel', 'cyberbiz_tags_json', 'sync_error', 'last_webhook_at');

-- 期望：0 列。標籤關聯不該指向不存在的客戶或標籤
SELECT COUNT(*) AS orphan_tag_links FROM crm_customer_tags t
WHERE NOT EXISTS (SELECT 1 FROM crm_customers c WHERE c.id = t.customer_id)
   OR NOT EXISTS (SELECT 1 FROM crm_tags g WHERE g.id = t.crm_tag_id);

SELECT '=== 0096 scopes 合併 ===' AS q;
-- 期望：cyberbiz/store 13、shopee/channel 1，沒有 report 或 payout
SELECT source_type, scope_kind, COUNT(*) AS n FROM scopes GROUP BY 1, 2;

-- 期望：0 列。同一個店名不該再有兩列
SELECT normalized_name, COUNT(*) AS n FROM scopes GROUP BY 1 HAVING n > 1;

-- 期望：13 列都有 drive 設定（蝦皮沒有，那是正常的）
SELECT COUNT(*) AS with_drive FROM scopes WHERE drive_folder_url <> '';

SELECT '=== items ===' AS q;
-- 期望：0 列。SKU 是全平台唯一
SELECT sku, COUNT(*) AS n FROM items GROUP BY 1 HAVING n > 1;
-- 期望：cyberbiz 143 / custom 11、supply 6
SELECT source, kind, COUNT(*) AS n FROM items GROUP BY 1, 2;

SELECT '=== item_categories 的兩層約束 ===' AS q;
-- 期望：三個都是 0
SELECT (SELECT COUNT(*) FROM item_categories WHERE depth NOT IN (0, 1)) AS bad_depth,
       (SELECT COUNT(*) FROM item_categories WHERE (depth = 0) <> (parent_id IS NULL)) AS bad_parent,
       (SELECT COUNT(*) FROM item_categories c WHERE c.parent_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM item_categories p WHERE p.id = c.parent_id AND p.depth = c.parent_depth)) AS orphan;

SELECT '=== 權限沒有被 0093 重建 users 弄丟 ===' AS q;
-- 期望：users 7、user_roles 7、user_role_assignments 7、role_permissions 100
SELECT (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM user_roles) AS user_roles,
       (SELECT COUNT(*) FROM user_role_assignments) AS role_assignments,
       (SELECT COUNT(*) FROM role_permissions) AS role_permissions;

SELECT '=== Parity：這三行必須跟 Phase 0.5 的基準一模一樣 ===' AS q;
-- 期望：4110 / 186529 / 29528346
SELECT COUNT(*) AS rows, SUM(net_quantity) AS net_qty, SUM(sales_amount) AS amount
FROM report_item_sales_monthly WHERE record_origin = 'imported';
-- 期望：383 / 5663 / 2014715
SELECT COUNT(*) AS rows, SUM(net_quantity) AS net_qty, SUM(sales_amount) AS amount
FROM report_item_sales_monthly WHERE record_origin = 'manual';
-- 期望：3369 / 45874851
SELECT COUNT(*) AS rows, SUM(payout_amount) AS amount FROM report_payout_daily_target;

SELECT '=== 外鍵 ===' AS q;
-- 期望：0 列
PRAGMA foreign_key_check;
