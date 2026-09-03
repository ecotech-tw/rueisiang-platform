# Platform schema 重整：執行計畫

**目標**：把資料庫從現況 51 張表換成
[`platform-schema-target.sql`](./platform-schema-target.sql) 的 32 張（＋小香
不動的 15 張＝47 張）。

為什麼要這樣改，見
[`platform-schema-overhaul.md`](./platform-schema-overhaul.md)。

---

## 決策：一次上線，不做 expand/contract

原本規劃的是七階段 expand/contract（先加新的、雙寫、切讀、再刪舊的）。
**改成單次上線**，理由是使用者的判斷：

> 有 breaking change 我們就是在 local 開 d1 測試完整一起上就對了

以這個系統的規模（一個 Worker、一萬多列客戶、報表資料以萬計）這是對的取捨：

| | expand/contract | 一次上線 |
|---|---|---|
| 部署次數 | 7 | **1** |
| 雙寫程式碼 | 要寫、要測、之後要拆 | ❌ 不用 |
| `_v2` 暫名 | 要 | ❌ 不用 |
| 停機 | 每次部署 1–2 分鐘 | **一次維護窗口** |
| 出錯怎麼辦 | 回上一階段 | **還原備份** |
| 風險集中度 | 分散 | 集中在一次 |

**代價很明確：migration 必須一次寫對。** 所以本機測試要用**正式資料的匯出檔**，
不能用空庫或假資料。

### 停機多久

`.github/workflows/deploy.yml` 的形狀是：

```
pnpm test → pnpm build → wrangler d1 migrations apply → wrangler deploy
                          ↑ 第 59 行                     ↑ 第 68 行
```

停機 = migration 執行時間 ＋ Worker 部署時間。**migration 那一段只能在有真資料
的地方量**（見 Phase 0.5），估計是數十秒到數分鐘。

📌 **文件不再宣稱「不停機」。** 排在離峰時段，事前公告。

---

## 兩條不可違反的硬規則

### 規則一：改名一律手寫 `ALTER TABLE ... RENAME TO`

**不能讓 drizzle 產「建新表 + 刪舊表」。**

`wrangler d1 migrations apply` 把**整支 migration 包在一個 transaction 裡**，
而 SQLite 規格說 `PRAGMA foreign_keys` 在 transaction 裡是 no-op，
`defer_foreign_keys` 也擋不住 `DROP TABLE` 的連坐刪除。

這個坑真的踩過：`0023` 在正式環境把 `assistant_line_groups` 全部連坐刪光，
本機看不出來（本機 runner 一句一句跑，PRAGMA 有效）。復原見
`0028_restore_line_groups.sql`。

**這一輪的地雷清單**（被 CASCADE 指著，DROP 之前必須先處理）：

| 表 | 被誰用 CASCADE 指著 | 處理順序 |
|---|---|---|
| `cyberbiz_products` | `cyberbiz_product_categories` | **先把分類搬進 `items.category_id`**，再 drop 兩張 |
| `zones` | `zone_images` | 先搬 `wms_zone_images`，再 drop |
| `roles` / `users` | `role_permissions` / `user_roles` / `user_permissions` | 授權表先搬到新名字 |
| `inventory_items` | `cyberbiz_product_links` | link 是對照來源，搬完 `items` 才能 drop |

`pnpm generate` 會問「這張表是不是改名了？」——**一定要回答是**。產完之後
**打開 SQL 確認**，看到 `DROP TABLE` 就是產錯了。

#### 同名不同結構的表要先讓路

`cyberbiz_products` 新舊同名但結構完全不同（舊的 PK 是 `sku`，新的是 `item_id`）。
在同一支 migration 裡：

```sql
ALTER TABLE cyberbiz_products RENAME TO cyberbiz_products_old;
CREATE TABLE cyberbiz_products (...);        -- 新的
-- 搬資料
-- ⚠️ 先把 cyberbiz_product_categories 的分類搬進 items.category_id
DROP TABLE cyberbiz_product_categories;
DROP TABLE cyberbiz_products_old;
```

`customers` → `crm_customers`、`saved_views` → `crm_saved_views`、
`customer_tag_catalog` → `crm_tags`、`users.name` → `google_name`、
`role_permissions` → `role_permission_grants`、`user_roles` →
`user_role_assignments`、`user_permissions` → `user_permission_grants`
都走 `RENAME TO`／`RENAME COLUMN`，不重建。

### 規則二：資料搬移一定要額外開一個檔案

drizzle 只會產「建新表」與「刪舊表」，中間那段
`INSERT INTO 新表 SELECT … FROM 舊表` 沒有人會幫你寫，不寫就是把歷史資料丟掉。

作法照 CLAUDE.md：先讓兩張表並存產出「建表」→ **手寫搬移** → 最後才移除舊表
定義產出「刪表」。範例是
`0007` → `0008_move_customer_events` → `0009`，測試在 `activity-migration.test.ts`。

⚠️ **migration 的測試要用 D1 的方式跑**——每一支包一個 transaction，而不是
一句一句 exec。不然測試會給出假的信心（範例：`line-group-recovery.test.ts`）。

---

## Phase 0：拆掉 stores.json（先做，獨立 PR）

**這一步不動 schema、不動資料**，但它是 `normalized_name` 移除的前置條件。
單獨做的好處是可以馬上驗證（跑一次出金表，看檔案有沒有正常上傳到 Drive）。

### 為什麼要先做

現在 driver 的 scope id 是**從店名算出來的**：

```js
// tools/cyberbiz-reports/lib/common.mjs:198
export function scopeIdFromStoreName(name) {
  return `cyberbiz:store:${Buffer.from(name, "utf8").toString("base64url")}`.slice(0, 100);
}
```

**改店名 → id 變了 → 匯入時對不到 → 建出一家新店 → 報表資料被切成兩半。**
`scopes.normalized_name` 就是在補這個洞（`report-data.ts:341` 的 name 分支）。

要拿掉 `normalized_name`，就得先讓 id 變成真正獨立的身分——也就是**由平台把
DB 裡的 scope id 傳給 driver**。

🎁 而且蝦皮的 workflow **已經做對了**：`shopee-sales-report.yml:10` 直接收
`drive_folder_url` 當 dispatch input，沒有 stores.json。出金與商品銷售是舊做法。

### 步驟

1. `payout.yml` / `cyberbiz-sales-report.yml` 加 `stores_json` input
   （每家店帶 `scopeId` + `name` + `driveFolderUrl` + `driveFolderName`）
2. `tools/cyberbiz-reports/lib/common.mjs:80` `loadConfig` 的 stores 覆蓋段刪掉
   （`config.json` 留著——那是 CYBERBIZ 網址、欄位公式，開發者的東西）
3. `scopeIdFromStoreName` 刪掉，scope id 改由 dispatch input 傳入
4. 刪 `apps/api/src/payout/github.ts` 與 `cyberbiz-sales/github.ts` 的
   `pushStores` / `STORES_PATH`、設定頁的 stores.json 下載按鈕、
   `tools/cyberbiz-reports/stores.json`
5. `GITHUB_TOKEN` 降權：不再需要 Contents 寫入，只留 Actions 觸發
   （`apps/api/src/env.ts:73` 的註解一併刪）
6. ⚠️ **觸發前擋掉空的 `driveFolderUrl`**——原本「commit 成功才存檔」那道防線
   消失了，不擋的話設定錯了要等執行十分鐘後才發現

### 驗收

跑一次出金表（單店、上個月），確認：檔案上傳到正確的 Drive 資料夾、平台收到
匯入結果、`report_scopes` 沒有多出新的一列。

---

## Phase 0.5：開 verify DB 並量測

**在 Cloudflare 開 `rueisiang-platform-verify`，把正式資料倒進去。**

```bash
npx wrangler d1 create rueisiang-platform-verify
npx wrangler d1 export rueisiang-platform --remote --output prod-backup.sql
npx wrangler d1 execute rueisiang-platform-verify --remote --file prod-backup.sql
```

⚠️ 這台開發機是 Windows on ARM，**跑不了 wrangler**（沒有 workerd）。這一步
要由人在別的環境執行，或用 Cloudflare 的網頁介面。

本機測試同一份匯出檔也用得上：
`apps/api/src/local-d1/` 的 `createLocalD1()` 吃 SQLite 檔，把匯出檔灌進去就是
一份跟正式一樣的資料。

### 要先量的數字

**D1 跑 migration 時資料庫是鎖住的，那個秒數就是停機時間**，而那只能在有真資料
的地方量。

- 匯出檔大小
- `customers` 列數
- `report_sales_monthly` 列數
- **整支 migration 在 verify 上跑完要幾秒**（這是要公告的停機時間）

### 要先跑的驗證查詢

這些的答案會**改變 migration 的寫法**，在寫程式之前就要有答案。

```sql
-- ══ items 身分合併 ══

-- 1. 有 link 但 SKU 對不上的（會被錯建成兩個 item——這正是要修的問題）
SELECT l.id, l.sku AS link_sku, i.sku AS wms_sku, c.sku AS cb_sku
FROM cyberbiz_product_links l
JOIN inventory_items i ON i.id = l.inventory_item_id
LEFT JOIN cyberbiz_products c
  ON c.product_id = l.cyberbiz_product_id AND c.variant_id = l.cyberbiz_variant_id
WHERE UPPER(COALESCE(i.sku,'')) <> COALESCE(c.sku,'');

-- 2. inventory_items 有多少筆 sku 是 NULL 或空（items.sku 是 NOT NULL）
SELECT COUNT(*) FROM inventory_items WHERE sku IS NULL OR sku = '';

-- 3. 其中有多少筆是有 link 的（有 link 就能拿官網 SKU，不用自動編號）
SELECT COUNT(*) FROM inventory_items i
JOIN cyberbiz_product_links l ON l.inventory_item_id = i.id
WHERE i.sku IS NULL OR i.sku = '';

-- 4. cyberbiz_products 的 (product_id, variant_id) 有無重複（要升 UNIQUE）
SELECT product_id, variant_id, COUNT(*) c
FROM cyberbiz_products GROUP BY 1,2 HAVING c > 1;

-- ══ 分類 ══

-- 5. custom_report_products.category 有多少不在 report_product_categories 裡
SELECT DISTINCT category FROM custom_report_products
WHERE category <> '未分類'
  AND category NOT IN (SELECT name FROM report_product_categories);

-- 6. inventory_items.category 有多少不在 warehouse_categories 字典裡
SELECT DISTINCT category FROM inventory_items
WHERE category NOT IN (SELECT name FROM warehouse_categories);

-- ══ scope 合併 ══

-- 7. 哪些 scope 會被合併（只看同名的，不是全表比對）
SELECT normalized_name, scope_kind, COUNT(*) c, GROUP_CONCAT(id)
FROM report_scopes GROUP BY 1,2 HAVING c > 1;

-- 8. legacy id（不是 cyberbiz:/shopee: 開頭的）
SELECT id, name FROM report_scopes
WHERE id NOT LIKE 'cyberbiz:%' AND id NOT LIKE 'shopee:%';

-- 9. payout_stores.name 與 report_scopes.name 是否完全對應（合併的前提）
SELECT p.name FROM payout_stores p
LEFT JOIN report_scopes s ON s.name = p.name
WHERE s.id IS NULL;

-- ══ 外部 SKU 對應 ══

-- 10. 真正的組合包有幾筆（決定歷史報表要不要人工修）
SELECT mapping_id, COUNT(*) c, MAX(quantity) q
FROM product_bundle_components GROUP BY 1 HAVING c > 1 OR q > 1;

-- 11. 同一個 (channel, external_sku) 同時是 mapping 又是 ignore（合併會撞 UNIQUE）
SELECT m.channel, m.external_sku FROM product_sku_mappings m
JOIN report_sku_ignores i ON i.channel = m.channel AND i.external_sku = m.external_sku;

-- 12. 蝦皮 external_sku 裡底線超過一個的（拆兩欄會拆錯）
SELECT external_sku FROM product_sku_mappings
WHERE channel = 'shopee'
  AND length(external_sku) - length(replace(external_sku,'_','')) > 1;

-- ══ 報表事實 ══

-- 13. report_sales_monthly.sku 對不到任何 items 來源的孤兒
SELECT COUNT(*) FROM report_sales_monthly s
WHERE NOT EXISTS (SELECT 1 FROM inventory_items i WHERE UPPER(i.sku) = s.sku)
  AND NOT EXISTS (SELECT 1 FROM cyberbiz_products c WHERE c.sku = s.sku)
  AND NOT EXISTS (SELECT 1 FROM custom_report_products p WHERE p.sku = s.sku);

-- ══ WMS ══

-- 14. inventory_items.shelf_level 的值分布（對不上 wms_shelves 的要有落點）
SELECT shelf_level, COUNT(*) FROM inventory_items GROUP BY 1;

-- 15. 有多少 zone_id IS NOT NULL AND shelf_level IS NULL（會失去區域資訊）
SELECT COUNT(*) FROM inventory_items WHERE zone_id IS NOT NULL AND shelf_level IS NULL;

-- ══ CRM／權限 ══

-- 16. 有多少 manual 客戶（決定要不要補推到官網）
SELECT COUNT(*) FROM customers WHERE source_channel = 'manual';

-- 17. role_permissions 有沒有 PERMISSIONS 以外的鍵值（新的 FK 會擋下來）
--     PERMISSIONS 的清單要從 packages/auth/src/permissions.ts 貼進來比對
SELECT DISTINCT permission FROM role_permissions;
```

---

## 上線那一次：migration 檔案的順序

一次部署，但檔案按子系統垂直切。**這樣 review 跟本機測試都好切，出錯時也看得出
是哪一段。**

```
0080_permissions_catalog        權限鏡像表 ＋ 兩張授權表改名、加 FK
0081_items_foundation           item_categories / items / cyberbiz_products / item_components
0082_backfill_items             ⚠️ 手寫：三層優先順序 ＋ _migration_item_map
0083_wms_tables                 wms_shelves / wms_layouts / wms_layout_elements / wms_items
0084_backfill_wms               ⚠️ 手寫：幾何、層、庫存
0085_report_tables              scopes / report_runs / 事實表 / issues
0086_backfill_reports           ⚠️ 手寫：scope 合併、外部對應、事實表
0087_crm_tables                 crm_tags / crm_customer_tags ＋ customers 改名與攤平
0088_backfill_crm               ⚠️ 手寫：標籤炸開
0089_rewrite_activity           ⚠️ 手寫：entity_type 與 entity_id
0090_drop_legacy                最後才刪，順序見「地雷清單」
```

📌 **`0090` 之前每一支都不刪東西**。真的出事時，停在 `0089` 的資料庫是新舊並存的，
還救得回來。

---

## 搬移的細節

### items：三層優先順序（⚠️ 不能只靠 SKU）

現有真正的 WMS↔CYBERBIZ 關係在 `cyberbiz_product_links`，不是 SKU 相等。
`wms-sync.ts` 的不變條件第 3 條就是「**SKU 對不上 → 連結失效**」——也就是說
**SKU 對不上的連結是存在的**，只是被標記成失敗。

只用 SKU 比對的話，那些會被錯建成兩個 item，**正好把這次要修的問題固化下來**。

```
1. cyberbiz_product_links（inventory_item_id ↔ product_id + variant_id）
2. 精確的 source + 正規化 SKU（UPPER + TRIM）
3. 都對不到 → 才建 custom item
```

⚠️ `inventory_items.sku` 可以是 NULL（驗證查詢 2、3）。有 link 的走第 1 層拿官網
SKU；沒有 link 又沒有 SKU 的，用 `WMS-` + 原 id 後八碼 —— 醜但唯一，而且看得出
是自動產生的，之後人搜得出來改。

#### 對照表要**持久化**，不用 TEMP

```sql
CREATE TABLE _migration_item_map (
  old_type   VARCHAR(20)  NOT NULL,   -- 'inventory' | 'cyberbiz' | 'custom'
  old_id     VARCHAR(255) NOT NULL,
  item_id    VARCHAR(36)  NOT NULL,
  -- 靠哪一條規則配對到的，出事時第一個要看的東西
  matched_by VARCHAR(20)  NOT NULL,   -- 'link' | 'sku' | 'new'
  PRIMARY KEY (old_type, old_id)
);
```

兩個理由：

1. **TEMP table 活不過 migration 檔案之間**（每支各自一個 transaction，
   可能不同連線），而 `0082` 建的對照表 `0086`、`0089` 都要用
2. **上線後要查得到**。下週有人問「為什麼這兩個商品變成同一個了」，
   沒有對照表就只能猜

📌 這張表**留著不刪**。幾千列，是這次搬移唯一的稽核紀錄。

### 分類

```sql
-- report_product_categories → item_categories（全部成為大分類，現在沒有階層）
INSERT INTO item_categories
  (id, depth, parent_id, parent_depth, name, color, sort_order, active, created_at, updated_at)
SELECT id, 0, NULL, NULL, name, color, 0, 1, created_at, updated_at
FROM report_product_categories;
```

✅ id 直接沿用，後面指過來的東西都不用改。

```sql
-- CYBERBIZ 商品的分類在 cyberbiz_product_categories
UPDATE items SET category_id = (
  SELECT c.category_id FROM cyberbiz_product_categories c
  JOIN _migration_item_map m ON m.old_type = 'cyberbiz' AND m.old_id = c.sku
  WHERE m.item_id = items.id
) WHERE source = 'cyberbiz';

-- 自訂商品的分類是名字字串，要先對到字典
UPDATE items SET category_id = (
  SELECT ic.id FROM custom_report_products p
  JOIN _migration_item_map m ON m.old_type = 'custom' AND m.old_id = p.id
  JOIN item_categories ic ON ic.name = p.category AND ic.parent_id IS NULL
  WHERE m.item_id = items.id
) WHERE source = 'custom' AND category_id IS NULL;
```

⚠️ 驗證查詢 5：對不到的分類名稱**要先建進 `item_categories`**，不能默默丟掉。
「未分類」→ NULL。

⚠️ **`cyberbiz_product_categories` 用 CASCADE 指著 `cyberbiz_products`**，
所以上面這兩段一定要在 drop 之前跑完。

### scope 合併：⚠️ 不可以直接加總

同月同 SKU 撞主鍵時**不能無條件加總**。如果兩個 scope 是同一家店被重複匯入的
alias，加總會把銷量與金額**算兩次**。

先建 canonical map，**只看會被合併的 scope**（驗證查詢 7），再分三種情況：

```sql
CREATE TABLE _migration_scope_map (
  old_id  VARCHAR(36) PRIMARY KEY,
  keep_id VARCHAR(36) NOT NULL
);
```

| 情況 | 處理 |
|---|---|
| 兩邊數值**完全一致** | 去重，只留一筆 |
| 月份／日期**互補**（各自有對方沒有的期間）| 可以合併 |
| **同鍵但數值不同** | 🚫 **擋下 migration**，產人工確認清單 |

第三種不能自動決定——那代表同一家店同一個月有兩個不同的數字，只有人知道哪個對。

📌 **出金（`report_payout_daily`）要做同一套檢查**，不能只做銷售。

### 報表事實表

```sql
-- 先建一筆「搬移」的 run，讓歷史列有東西可以指
INSERT INTO report_runs
  (id, request_id, source_type, imports_sales, imports_payout,
   period_kind, start_date, end_date, status, actor_email, created_at, updated_at)
VALUES
  ('...', 'migration:cyberbiz:0086', 'cyberbiz', 1, 1, 'custom',
   (SELECT MIN(business_date) FROM report_payout_daily),
   (SELECT MAX(business_date) FROM report_payout_daily),
   'succeeded', 'system@migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
```

理由：`report_run_id` 的 CHECK 要求 imported 列一定有 run，而歷史資料沒有。
用 NULL 的話那個 NULL 會有兩種意思（「歷史」還是「run 被刪了」），假 run 沒有
這個問題——`request_id` 的前綴與 `actor_email` 一眼看得出來。

```sql
INSERT INTO report_item_sales_monthly
  (scope_id, report_month, item_id, record_origin, report_run_id,
   gross_quantity, return_quantity, net_quantity, sales_amount,
   item_name_snapshot, category_name_snapshot, category_parent_name_snapshot,
   updated_by_email, created_at, updated_at)
SELECT COALESCE(sm.keep_id, s.scope_id), s.report_month, m.item_id,
       'imported', (SELECT id FROM report_runs WHERE request_id = 'migration:cyberbiz:0086'),
       s.gross_quantity, s.return_quantity, s.net_quantity, s.sales_amount,
       -- 舊表本來就有這兩欄快照，直接沿用
       s.product_name, s.category, '',
       '', s.updated_at, s.updated_at
FROM report_sales_monthly s
JOIN _migration_item_map m ON m.old_id = s.sku
LEFT JOIN _migration_scope_map sm ON sm.old_id = s.scope_id;
```

⚠️ **`JOIN _migration_item_map` 是 INNER JOIN**——對不到的列會被默默丟掉。
驗證查詢 13 就是在數這個。**對不到的必須先有落點**，不能靠 JOIN 吃掉。

⚠️ `category_parent_name_snapshot` 搬移時一律 `''`：現在沒有階層，都是大分類。
之後建了階層，新資料才會有值。

人工的那一張 `record_origin='manual'`、`report_run_id` 是 NULL、
`updated_by_email` 從舊表帶過來。出金兩張同理，只是沒有商品與分類。

### 標籤：⚠️ 要先複製字典

```sql
-- 1. 先整份複製 catalog——漏了這步的話，字典裡本來就有的標籤（VIP）
--    不會進 crm_tags，第 3 步的 JOIN 就對不到，那些關聯會全部消失
INSERT INTO crm_tags (id, name, created_at, updated_at)
SELECT id, name, created_at, updated_at FROM customer_tag_catalog;

-- 2. 再補客戶身上有、字典沒有的
INSERT INTO crm_tags (id, name, created_at, updated_at)
SELECT DISTINCT lower(hex(randomblob(16))), json_each.value,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM customers, json_each(customers.cyberbiz_tags_json)
WHERE json_each.value NOT IN (SELECT name FROM crm_tags);

-- 3. 最後炸開成關聯
INSERT INTO crm_customer_tags (customer_id, crm_tag_id)
SELECT c.id, t.id
FROM customers c, json_each(c.cyberbiz_tags_json)
JOIN crm_tags t ON t.name = json_each.value;
```

📌 順序不能換。

### 外部 SKU 對應

⚠️ 驗證查詢 11：同一個 `(channel, external_sku)` 同時在 mapping 與 ignore 兩邊
會撞 UNIQUE。**ignore 贏**——那是刻意設定的，mapping 可能只是還沒清掉。

⚠️ 驗證查詢 12：蝦皮的底線拆法

```sql
external_key = CASE WHEN instr(external_sku,'_') > 0
                    THEN substr(external_sku, 1, instr(external_sku,'_') - 1)
                    ELSE external_sku END,
external_variant_key = CASE WHEN instr(external_sku,'_') > 0
                    THEN substr(external_sku, instr(external_sku,'_') + 1)
                    ELSE '' END
```

⚠️ **組合包**（驗證查詢 10）：
- 一列且數量 1 → `item_id` 直接指過去，不建 `item_components`
- 多列或數量 > 1 → 建一個 `source='custom'` 的 item ＋ N 列 `item_components`。
  名稱只能用 `external_name`——搬移程式看不出它是不是對應官網某個真的禮盒，
  **搬完要產一份人工確認清單**

### `activity_events`

```sql
UPDATE activity_events SET entity_type = 'item'
  WHERE entity_type IN ('inventory_item','product');
UPDATE activity_events SET entity_type = 'scope'  WHERE entity_type = 'report_scope';
UPDATE activity_events SET entity_type = 'wms_category'
  WHERE entity_type = 'warehouse_category';

-- ⚠️ entity_id 也要改：items 的 id 是重新產生的
UPDATE activity_events SET entity_id = (
  SELECT m.item_id FROM _migration_item_map m
  WHERE m.old_type = 'inventory' AND m.old_id = activity_events.entity_id
) WHERE entity_type = 'item'
  AND EXISTS (SELECT 1 FROM _migration_item_map m
              WHERE m.old_type = 'inventory' AND m.old_id = activity_events.entity_id);
```

不改的話「這個商品的歷程」只看得到搬移之後的紀錄：**頁面正常打開、沒有錯誤、
只是空的**。

---

## Parity check：搬完一定要對數字

寫成 migration 的**測試**，不是人工跑一次。

```sql
-- 銷售：三個數字都要一模一樣
SELECT SUM(net_quantity), SUM(sales_amount), COUNT(*) FROM report_sales_monthly;
SELECT SUM(net_quantity), SUM(sales_amount), COUNT(*)
FROM report_item_sales_monthly WHERE record_origin = 'imported';

-- 出金
SELECT SUM(payout_amount), COUNT(*) FROM report_payout_daily_old;
SELECT SUM(payout_amount), COUNT(*)
FROM report_payout_daily WHERE record_origin = 'imported';

-- 逐月對，不要只對總數（總數相同但月份錯位看不出來）
SELECT report_month, SUM(sales_amount) FROM ... GROUP BY 1;

-- 客戶、標籤關聯、item 數
SELECT COUNT(*) FROM customers;                    -- vs crm_customers
SELECT COUNT(*) FROM crm_customer_tags;            -- vs JSON 炸開的總數
SELECT COUNT(*) FROM _migration_item_map;          -- vs 三個來源的去重總數
```

⚠️ **筆數可以不同**（scope 合併會讓筆數變少），**但金額與數量的總和必須完全
相等**。不相等就是 migration 失敗，不准繼續。

---

## 上線流程

1. **備份**：`wrangler d1 export`，並在 verify DB 上**試還原一次**
   （沒試過的備份不算備份）
2. 公告維護窗口（時間長度來自 Phase 0.5 的量測）
3. merge → `deploy.yml` 自動跑 migration ＋ 部署
4. 跑 parity check 的查詢，對數字
5. 手動走一次：客戶列表、倉庫地圖、商品銷售報表、出金報表、小香問一次庫存

### 回滾

**沒有 migration 層級的回滾。** 出錯的處理是：

1. 還原備份（`wrangler d1 execute --file`）
2. 部署上一版 Worker

所以第 1 步的備份驗證**不可以跳過**。

---

## 上線後的收尾

- 移除 `packages/db` 裡指向舊表的死程式碼
- 小香的 8 個工具跟著新的函式回傳形狀更新，三個變形狀的各補一個測試
  （`listTags` / `customerStats` / `loadWarehouse`）
- `writePermissions` 補上 PERMISSIONS 檢查（跟 `grantPermission` 同一套判斷）
- ➕ **webhook 事件的清理排程**（cron 已經每 15 分在跑，順手加一段）：
  ```sql
  DELETE FROM cyberbiz_webhook_events
  WHERE status IN ('processed','ignored') AND received_at < date('now','-30 days');
  ```
  失敗的**不要刪**——那是還沒解決的問題。
- 更新 `README.md` 的「下一步」與 `docs/` 裡受影響的設計文件

---

## 分工

**同一時間只能有一個人改 schema。** 這是這次最大的協作風險——兩個 agent 各自
跑 `pnpm generate` 會產生編號衝突的 migration（這件事這個 repo 已經發生過一次，
`0070` 撞號）。

建議：`0080`–`0090` 由同一個 worktree 完成，另一邊只做 review。
