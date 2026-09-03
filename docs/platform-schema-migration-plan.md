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

同一份店別清單存在**三個地方**：D1 的 `payout_stores`、runner repo 的
`tools/cyberbiz-reports/stores.json`、以及工具自己的 `config.json`。改了其中一個，
另外兩個不會跟著動——`schema/tools.ts` 的註解自己承認過這個落差。

而且 scope id 的推導寫在兩個地方：driver 的 `scopeIdFromStoreName`（JS）與平台的
`cyberbizScopeIdFromStoreName`（TS）。同一條規則、兩個 repo、兩個語言。

⚠️ **這一步不會讓改店名變安全。** scope id 仍然是 base64url(店名) 算出來的，只是
改成由平台算一次再傳過去。**`normalized_name` 還不能拿掉**——它要等 `payout_stores`
併進 `scopes`、scope id 變成一個真正的欄位之後才能移除（見 `0085_report_tables`）。
Phase 0 做的是**把三份清單收成一份**，以及把推導收成一處。

🎁 而且蝦皮的 workflow **已經做對了**：`shopee-sales-report.yml:10` 直接收
`drive_folder_url` 當 dispatch input，沒有 stores.json。出金與商品銷售是舊做法。

### 步驟

1. `payout.yml` / `cyberbiz-sales-report.yml` 加 `stores_json` input，
   透過 `REPORT_STORES_JSON` 傳給 driver（每家店帶 `scopeId` + `name` +
   `driveFolderUrl` + `driveFolderName`）
2. `loadConfig` 改吃 `storesOverride`，`parseStoresInput` 負責解析與驗證；
   壞掉的輸入要吵，不能默默退回 config.json
3. `scopeIdFromStoreName` 換成 `storeScopeId(store)`——scope id 一律由上層給，
   driver 不再自己算
4. 刪 `pushStores` / `STORES_PATH` / base64 helper 與
   `tools/cyberbiz-reports/stores.json`；`config.json` 的店別補上 `scopeId`，
   給從 Actions 頁面手動執行時用
5. `GITHUB_TOKEN` 降權：不再需要 Contents 寫入，只留 Actions 觸發
6. 設定頁的存檔不再回傳 `syncedToRepo` / `committed`

📌 已完成，見 PR「報表店別改由 D1 傳給 runner」。

### 驗收

跑一次出金表（單店、上個月），確認：檔案上傳到正確的 Drive 資料夾、平台收到
匯入結果、`report_scopes` 沒有多出新的一列。

---

## Phase 0.5：驗證與量測

### ✅ 已完成：對正式資料跑過 17 支驗證查詢

做法是 `wrangler d1 export` 之後在本機用 SQLite 跑——那 17 支全部是唯讀 SELECT，
不必等 verify DB。

⚠️ **`wrangler d1 export` 出來的檔案順序是壞的**：子表的 INSERT 排在父表前面，
直接餵給 D1 會噴 `no such table: main.roles`。要先依外鍵相依拓撲排序重排
（順便注意有 7 張表是 `CREATE TABLE IF NOT EXISTS "name"` 而不是反引號，
寫解析程式時容易把表名讀成 `IF`）。

### 結果：資料乾淨，原本的防禦性設計大半用不到

| # | 檢查 | 結果 |
|---|---|---|
| 1 | 有 link 但 SKU 對不上 | **0** |
| 2 | `inventory_items.sku` 是 NULL／空 | **6**（見下）|
| 3 | 其中有 link 的 | 0 |
| 4 | cyberbiz `(product_id, variant_id)` 重複 | **0** |
| 5 | `custom_report_products.category` 不在字典 | **0** |
| 6 | `inventory_items.category` 不在字典 | **0** |
| 7 | 會被合併的 scope | **0** |
| 8 | legacy scope id | **0** |
| 9 | `payout_stores` 對不到 `report_scopes` | **1**（見下）|
| 10 | 真正的組合包 | **0** |
| 11 | 同時是 mapping 又是 ignore | **0** |
| 12 | 蝦皮 `external_sku` 底線超過一個 | **0** |
| 13 | 報表孤兒 SKU | **0** |
| 14 | `shelf_level` 值分布 | 兩種格式（見下）|
| 15 | 有 zone 沒 shelf_level | **1** |
| 16 | manual 客戶 | **0**（11,061 筆全是 cyberbiz）|
| 17 | `role_permissions` 的鍵值 | DB 38 個 = 程式碼 38 個，**沒有孤兒** |

**因此可以砍掉的段落**：

- scope 合併的 canonical map 與「三種情況分開處理」——**沒有 scope 要合併**
- 組合包的 custom item 建立與人工確認清單——**71 筆全是一對一數量 1**
- manual 客戶的補推討論——**一筆都沒有**
- 分類補建——**沒有對不上的名稱**

`permissions` 鏡像表的外鍵也可以直接套上去，不必先清資料。

### ⚠️ 只有三件事要處理

**1. 6 筆沒有 SKU 的 `inventory_items`**

全是包材／半成品：`淋膜紙`、`護髮素蓋子`、`護髮素軟管`、`養皂3入禮盒`、
`養皂（未包）`、`護髮素罐裝空瓶`。都沒有 link，所以要自動編號
（`WMS-` + 原 id 後八碼）並給 `kind='supply'`。

📌 **只有 6 筆，也可以在搬移前請人補上真的 SKU**，那樣更乾淨。

**2. 店別清單兩邊各缺一個**

`payout_stores` 有「裕隆城」（已停用）而 `report_scopes` 沒有；
`report_scopes` 有「蝦皮」而 `payout_stores` 沒有。合併成 `scopes` 時取聯集。

⚠️ 蝦皮現在是 `scope_kind='store'`，搬移時要改成 `'channel'`。

**3. `shelf_level` 有兩種格式**

52 筆是 `top` / `middle` / `bottom`（`zones.shelf_levels` 的預設三層），
16 筆是 UUID（香水區、麻紗巾這些後來自訂分層的倉位），1 筆有 zone 但沒
shelf_level。`wms_shelves` 兩種都要對得上，那 1 筆要有落點。

### 資料量：停機應該是秒級

| 表 | 列數 |
|---|---|
| `customers` | 11,061 |
| `cyberbiz_customer_webhooks` | 4,288 |
| `report_sales_monthly` | 4,110 |
| `report_payout_daily` | 3,369 |
| `activity_events` | 2,593 |
| `report_manual_sales_monthly` | 383 |
| 其餘每張 | < 600 |

匯出檔 34 MB。最大的表一萬多列，所以整支 migration 預期是**秒級**，不是分鐘級。

### 🔒 Parity check 的基準（搬完必須一模一樣）

```
report_sales_monthly         net_quantity 186,529 / sales_amount 29,528,346 / 4,110 列
report_payout_daily          payout_amount 45,874,851 / 3,369 列
report_manual_sales_monthly  net_quantity 5,663 / sales_amount 2,014,715 / 383 列
report_manual_payout_daily   0 列
```

### 還沒做：verify DB（0.5b）

```bash
npx wrangler d1 create rueisiang-platform-verify
npx wrangler d1 export rueisiang-platform --remote --output prod-backup.sql
# ⚠️ 要用重排過的檔案；原始匯出檔會因為外鍵順序失敗
npx wrangler d1 execute rueisiang-platform-verify --remote --file prod-backup-ordered.sql
```

⚠️ 這台開發機是 Windows on ARM，**跑不了 wrangler**（沒有 workerd）。

它剩下的用途只有兩個：**量整支 migration 在 D1 上跑幾秒**，以及**驗證備份還原得
回去**（沒試過的備份不算備份）。查詢的答案已經有了。

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

✅ **Phase 0.5 實測目前是 0 筆**——三層優先順序仍然照做（成本很低，而且 link
本來就是比 SKU 更準的來源），但不必為了搶救資料而緊張。

```
1. cyberbiz_product_links（inventory_item_id ↔ product_id + variant_id）
2. 精確的 source + 正規化 SKU（UPPER + TRIM）
3. 都對不到 → 才建 custom item
```

⚠️ `inventory_items.sku` 可以是 NULL。**實測 6 筆，而且都沒有 link**：
`淋膜紙`、`護髮素蓋子`、`護髮素軟管`、`養皂3入禮盒`、`養皂（未包）`、
`護髮素罐裝空瓶`——全是包材／半成品，`kind='supply'`。

用 `WMS-` + 原 id 後八碼自動編號：醜但唯一，而且看得出是自動產生的。
📌 **只有 6 筆，也可以在搬移前請人補上真的 SKU**，那樣更乾淨。

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

### scope 合併：✅ 不需要（Phase 0.5 已驗證）

正式資料裡**沒有任何同名 scope**（驗證查詢 7 回 0 筆），也沒有 legacy id
（查詢 8 回 0 筆）。原本規劃的 canonical map 與「數值一致去重／日期互補合併／
同鍵不同值擋下 migration」三種情況**都用不到**，`report_sales_monthly` 的主鍵
也不會撞。

⚠️ 但 `payout_stores` 與 `report_scopes` 的清單**不完全一樣**（查詢 9）：
前者有「裕隆城」（已停用），後者有「蝦皮」。合併成 `scopes` 時取聯集，
並把蝦皮那一列的 `scope_kind` 從 `'store'` 改成 `'channel'`。

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
   updated_by_email, created_at, updated_at)
SELECT COALESCE(sm.keep_id, s.scope_id), s.report_month, m.item_id,
       'imported', (SELECT id FROM report_runs WHERE request_id = 'migration:cyberbiz:0086'),
       s.gross_quantity, s.return_quantity, s.net_quantity, s.sales_amount,
       '', s.updated_at, s.updated_at
FROM report_sales_monthly s
JOIN _migration_item_map m ON m.old_id = s.sku
LEFT JOIN _migration_scope_map sm ON sm.old_id = s.scope_id;
```

⚠️ **`JOIN _migration_item_map` 是 INNER JOIN**——對不到的列會被默默丟掉。
驗證查詢 13 就是在數這個。**對不到的必須先有落點**，不能靠 JOIN 吃掉。

📌 舊表的 `product_name` 與 `category` 兩欄**不搬**——報表一律 join `items`
（理由見 overhaul 的 #35）。⚠️ 這代表搬完之後，歷史報表的分類會跟著**現在的**
分類走，不是匯入當時的。這是刻意接受的代價，**上線前要讓看報表的人知道**。

人工的那一張 `record_origin='manual'`、`report_run_id` 是 NULL、
`updated_by_email` 從舊表帶過來。出金兩張同理，只是沒有商品與分類。

### 標籤：⚠️ 要先複製字典（順序不能換）

📌 Phase 0.5 實測 `customer_tag_catalog` 與 `saved_views` **都是 0 列**，
所以這一段實際上沒有資料要搬。步驟仍然寫在這裡——正式環境隨時可能開始用。

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

✅ **組合包不需要處理**（驗證查詢 10 回 0 筆）：`product_bundle_components`
的 71 列全部是「一筆用料、數量 1」，也就是一對一。搬移時 `item_id` 直接指過去，
不必建 custom item，也不會有需要人工確認的清單。

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

⚠️ **金額與數量的總和必須完全相等**。不相等就是 migration 失敗，不准繼續。
（沒有 scope 要合併，所以這一輪**筆數也應該一模一樣**。）

Phase 0.5 量到的基準：

```
report_sales_monthly         net_quantity 186,529 / sales_amount 29,528,346 / 4,110 列
report_payout_daily          payout_amount 45,874,851 / 3,369 列
report_manual_sales_monthly  net_quantity 5,663 / sales_amount 2,014,715 / 383 列
report_manual_payout_daily   0 列
```

---

## 目前 Codex 實作狀態（2026-09-03）

已先以手寫 migration 草稿完成本機測試收斂：

- `0073_permissions_auth_rename.sql`：建立 `permissions` 鏡像表，新增 auth grant 表，並用 trigger 暫時同步 legacy 表，讓舊 migration 測試與新查詢路徑都能工作。
- `0074_crm_rename_foundation.sql`：CRM 表改名前置、`raw_json` / `synced_at` 欄位 rename、webhook unified table 補 product/customer 共用欄位。
- `0075_items_wms_foundation.sql`：建立 `item_categories` / `items` 與 WMS 新 foundation tables。
- `0076_media_storage_provider.sql`：補 `media_objects.storage_provider`。
- `0077_report_scopes_foundation.sql`：建立 unified `scopes`，先從 `report_scopes` / `payout_stores` 回填。

本機驗證：

- `pnpm typecheck` 通過。
- `pnpm --filter @rueisiang/api exec vitest run --pool=threads --poolOptions.threads.singleThread` 通過（40 files / 661 tests）。
- `pnpm --filter @rueisiang/api build`、`pnpm --filter @rueisiang/portal build` 通過。

⚠️ 這些 migration 仍是草稿：正式前必須在 verify D1 對正式匯出檔重跑，尤其要確認 legacy trigger / view 只是過渡安全網，不會被誤當成最終 contract。

---

## 上線流程

1. **備份**：`wrangler d1 export`，**依外鍵相依重排**（原始匯出檔還原會失敗，
   見 Phase 0.5），並在 verify DB 上**試還原一次**——沒試過的備份不算備份
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
