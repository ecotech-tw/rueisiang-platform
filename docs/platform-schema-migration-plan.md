# Platform schema 重整：執行計畫

**目標**：把資料庫從現況 51 張表換成
[`platform-schema-target.sql`](./platform-schema-target.sql) 的 31 張，**不停機**。

為什麼要這樣改，見
[`platform-schema-overhaul.md`](./platform-schema-overhaul.md)。

---

## 先講結論

**不停機做得到，但代價是七個 PR、七次部署，不是一天做完。**

真正的限制不是時間，是 `.github/workflows/deploy.yml` 的形狀：

```
pnpm test  →  pnpm build  →  wrangler d1 migrations apply  →  wrangler deploy
                             ↑ 第 59 行                       ↑ 第 68 行
```

**migration 先跑，Worker 後部署。** 中間那一到兩分鐘，舊的 Worker 還在服務，
但資料庫已經是新的。所以：

| 動作 | 那一兩分鐘會怎樣 |
|---|---|
| 加表、加欄位（nullable / 有 default） | ✅ 舊 Worker 看不到，照常運作 |
| 改名、刪表、刪欄位 | ❌ 舊 Worker 打不到 → 500 |

**這就是為什麼要 expand / contract**：先加新的、雙寫、切讀、再刪舊的。
每一步之間 schema 都同時滿足新舊兩版程式。

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

**這一輪的地雷清單**（被 CASCADE 指著、不可 DROP）：

| 表 | 被誰用 CASCADE 指著 |
|---|---|
| `cyberbiz_products` | `cyberbiz_product_categories` |
| `zones` | `zone_images` |
| `customers` | `cyberbiz_customer_webhooks`（SET NULL，但仍會改動）|
| `roles` / `users` | `role_permissions` / `user_roles` / `user_permissions` |

`pnpm generate` 會問「這張表是不是改名了？」——**一定要回答是**。產完之後
**打開 SQL 確認**，看到 `DROP TABLE` 就是產錯了。

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

**這一步不動 schema、不動資料**，但它是 Phase 4 的前置條件。單獨做的好處是
可以馬上驗證（跑一次出金表，看檔案有沒有正常上傳到 Drive）。

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

### 要先量的數字

**D1 跑 migration 時資料庫是鎖住的，那個秒數就是真正的停機時間**，而那只能在
有真資料的地方量。

- 匯出檔大小
- `customers` 列數
- `report_sales_monthly` 列數
- 每一支 migration 在 verify 上跑完要幾秒

### 要先跑的驗證查詢

這些的答案會改變後面的做法，**在寫 migration 之前就要有答案**。

```sql
-- 1. 有多少 scope 是同名重複的（合併會動到幾筆）
SELECT normalized_name, scope_kind, COUNT(*) c
FROM report_scopes GROUP BY 1,2 HAVING c > 1;

-- 2. 有多少 legacy id（不是 cyberbiz:/shopee: 開頭的）
SELECT id, name FROM report_scopes
WHERE id NOT LIKE 'cyberbiz:%' AND id NOT LIKE 'shopee:%';

-- 3. 合併 scope 會不會撞 report_sales_monthly 的主鍵
SELECT COUNT(*) FROM report_sales_monthly a
JOIN report_sales_monthly b
  ON a.report_month = b.report_month AND a.sku = b.sku AND a.scope_id <> b.scope_id;

-- 4. payout_stores.name 與 report_scopes.name 是否完全對應（合併的前提）
SELECT p.name FROM payout_stores p
LEFT JOIN report_scopes s ON s.name = p.name
WHERE s.id IS NULL;

-- 5. 真正的組合包有幾筆（決定歷史報表要不要人工修）
SELECT mapping_id, COUNT(*) c, MAX(quantity) q
FROM product_bundle_components GROUP BY 1 HAVING c > 1 OR q > 1;

-- 6. 同一個 (channel, external_sku) 同時出現在 mapping 與 ignore（合併會撞 UNIQUE）
SELECT m.channel, m.external_sku FROM product_sku_mappings m
JOIN report_sku_ignores i ON i.channel = m.channel AND i.external_sku = m.external_sku;

-- 7. 蝦皮 external_sku 裡底線超過一個的（拆兩欄會拆錯）
SELECT external_sku FROM product_sku_mappings
WHERE channel = 'shopee'
  AND length(external_sku) - length(replace(external_sku,'_','')) > 1;

-- 8. report_sales_monthly.sku 對不到任何 items 來源的孤兒
SELECT COUNT(*) FROM report_sales_monthly s
WHERE NOT EXISTS (SELECT 1 FROM inventory_items i WHERE UPPER(i.sku) = s.sku)
  AND NOT EXISTS (SELECT 1 FROM cyberbiz_products c WHERE c.sku = s.sku)
  AND NOT EXISTS (SELECT 1 FROM custom_report_products p WHERE p.sku = s.sku);

-- 9. inventory_items 有多少筆 sku 是 NULL（items.sku 是 NOT NULL）
SELECT COUNT(*) FROM inventory_items WHERE sku IS NULL OR sku = '';

-- 10. inventory_items.shelf_level 的值分布（對不上 wms_shelves 的要有落點）
SELECT shelf_level, COUNT(*) FROM inventory_items GROUP BY 1;

-- 11. 有多少 zone_id IS NOT NULL AND shelf_level IS NULL（這些會失去區域資訊）
SELECT COUNT(*) FROM inventory_items WHERE zone_id IS NOT NULL AND shelf_level IS NULL;

-- 12. inventory_items.category 有多少不在 warehouse_categories 字典裡
SELECT DISTINCT category FROM inventory_items
WHERE category NOT IN (SELECT name FROM warehouse_categories);

-- 13. cyberbiz_products 的 (product_id, variant_id) 有無重複（要升 UNIQUE）
SELECT product_id, variant_id, COUNT(*) c
FROM cyberbiz_products GROUP BY 1,2 HAVING c > 1;

-- 14. 有多少 manual 客戶（決定要不要補推到官網）
SELECT COUNT(*) FROM customers WHERE source_channel = 'manual';
```

---

## Phase 1：加東西（零風險）

**只有 CREATE TABLE 與 nullable 的 ADD COLUMN，舊 Worker 完全不受影響。**

- `item_categories`（含 `parent_id`）
- `items`
- `item_components`
- `wms_shelves`
- `wms_layouts` / `wms_layout_elements`
- `scopes`
- `report_external_products`
- `report_runs` / `report_run_scopes` / `report_run_reports`
- `report_item_sales_monthly`
- `report_payout_daily_v2`（暫名，Phase 5 才改回正式名）
- `report_ingest_issues`
- `crm_tags` 的新欄位、`crm_customer_tags`
- `cyberbiz_webhook_events`
- `crm_customers` 補上要攤平進來的 CYBERBIZ 欄位（全部 nullable）
- `media_objects.storage_provider`（有 default）

這一步之後**新舊表並存，程式還在讀舊的**。可以放著跑幾天觀察。

---

## Phase 2：搬資料（手寫，最需要測試）

每一段都要有對應的測試，照 `activity-migration.test.ts` 的形狀寫。

### 2.1 建立 `items`（最重要的一段）

三個來源合成一個身分空間。**順序有意義**：先建 CYBERBIZ 的（它有最完整的
名稱），再補 WMS 只有的，最後是自訂的。

```sql
-- (a) CYBERBIZ 商品
INSERT INTO items (id, source, kind, sku, name, active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'cyberbiz', 'sellable',
       c.sku, c.product_name, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM cyberbiz_products c;

-- (b) WMS 有、官網沒有的（自製材料、包材）
INSERT INTO items (id, source, kind, sku, name, active, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'custom', 'supply',
       UPPER(i.sku), i.name, 1, i.created_at, i.updated_at
FROM inventory_items i
WHERE i.sku IS NOT NULL AND i.sku <> ''
  AND NOT EXISTS (SELECT 1 FROM cyberbiz_products c WHERE c.sku = UPPER(i.sku));

-- (c) 報表自訂商品
INSERT INTO items (...) SELECT ... FROM custom_report_products p
WHERE NOT EXISTS (SELECT 1 FROM items x WHERE x.sku = p.sku);
```

⚠️ **驗證查詢 9**：`inventory_items.sku` 可以是 NULL，但 `items.sku` 是
NOT NULL。有 NULL 的話要先決定自動編號規則（建議 `WMS-` + 流水號），
而且要寫進 migration 而不是事後手動補。

⚠️ **`kind` 的初始值**：(a) 全部給 `sellable`，(b) 全部給 `supply`。
分錯的（例如官網有賣的紅紙袋其實是包材）留給人事後在 UI 改——**分錯看得見，
反過來會默默消失在報表裡**。

### 2.2 建立對照表（後面每一段都要用）

```sql
CREATE TEMP TABLE item_map AS
SELECT i.id AS item_id, i.sku, i.source,
       (SELECT id FROM inventory_items w WHERE UPPER(w.sku) = i.sku) AS old_inventory_id,
       (SELECT sku FROM cyberbiz_products c WHERE c.sku = i.sku) AS old_cyberbiz_sku,
       (SELECT id FROM custom_report_products p WHERE p.sku = i.sku) AS old_custom_id
FROM items i;
```

### 2.3 合併 scope（⚠️ 會撞主鍵）

驗證查詢 1 與 3 的答案決定這一段。

```sql
CREATE TEMP TABLE scope_merge AS
SELECT s.id AS old_id,
       (SELECT s2.id FROM report_scopes s2
         WHERE s2.normalized_name = s.normalized_name
           AND s2.scope_kind = s.scope_kind
         ORDER BY s2.created_at LIMIT 1) AS keep_id
FROM report_scopes s;
```

⚠️ `report_sales_monthly` 的主鍵是 `(scope_id, report_month, sku)`。兩個 scope
合併時**同月同 SKU 會撞**——必須**先加總再寫**，不可以直接 UPDATE。
這一段一定要有測試。

### 2.4 標籤 JSON 炸開

```sql
-- 字典裡沒有的標籤先補建
INSERT INTO crm_tags (id, name, created_at, updated_at)
SELECT DISTINCT lower(hex(randomblob(16))), json_each.value,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM customers, json_each(customers.cyberbiz_tags_json)
WHERE json_each.value NOT IN (SELECT name FROM customer_tag_catalog);

-- 再炸開成關聯
INSERT INTO crm_customer_tags (customer_id, crm_tag_id)
SELECT c.id, t.id
FROM customers c, json_each(c.cyberbiz_tags_json)
JOIN crm_tags t ON t.name = json_each.value;
```

### 2.5 外部 SKU 對應（mapping + ignore 合併、身分拆兩欄）

⚠️ 驗證查詢 6：同一個 `(channel, external_sku)` 同時在兩邊的話會撞 UNIQUE，
要先決定哪一邊贏（建議 **ignore 贏**——那是刻意設定的）。

⚠️ 驗證查詢 7：蝦皮的底線拆法

```sql
external_key = CASE WHEN instr(external_sku,'_') > 0
                    THEN substr(external_sku, 1, instr(external_sku,'_') - 1)
                    ELSE external_sku END,
external_variant_key = CASE WHEN instr(external_sku,'_') > 0
                    THEN substr(external_sku, instr(external_sku,'_') + 1)
                    ELSE '' END
```

⚠️ **組合包**（驗證查詢 5）：
- 一列且數量 1 → `item_id` 直接指過去，不建 `item_components`
- 多列或數量 > 1 → 建一個 `source='custom'` 的 item ＋ N 列 `item_components`。
  名稱只能用 `external_name`——搬移程式看不出它是不是對應官網某個真的禮盒，
  **搬完要產一份人工確認清單**

### 2.6 `activity_events.entity_type` 改值

```sql
UPDATE activity_events SET entity_type = 'item'
  WHERE entity_type IN ('inventory_item','product');
UPDATE activity_events SET entity_type = 'scope'  WHERE entity_type = 'report_scope';
UPDATE activity_events SET entity_type = 'wms_category'
  WHERE entity_type = 'warehouse_category';
```

⚠️ **`entity_id` 也要改**——items 的 id 是重新產生的，舊紀錄指的是舊 id。
用 2.2 的 `item_map` 一起改。

不改的話「這個商品的歷程」只看得到搬移之後的紀錄：**頁面正常打開、沒有錯誤、
只是空的**。而且 `report_item_sales_monthly` 不存名稱快照就是靠這條路。

### 2.7 其餘

- `zones` / `layout_elements` 的幾何 → `wms_layout_elements`
- `zones.shelf_levels`（JSON）→ `wms_shelves`（驗證查詢 10、11）
- `payout_stores` + `report_scopes` + `shopee_sales_settings` → `scopes`
- 三張 `*_runs` → `report_runs` + `report_run_scopes`
- 兩張 webhook 表 → `cyberbiz_webhook_events`
- `customers` 的 CYBERBIZ 欄位就地留著（同一張表，不用搬）

---

## Phase 3：雙寫

程式改成**同時寫新舊兩份**，讀還是讀舊的。

這一步是為了讓 Phase 2 到 Phase 4 之間新進來的資料不會漏。跑一整天，用
Phase 2 的搬移查詢對一次兩邊的筆數。

---

## Phase 4：切讀

`packages/db` 的查詢改成讀新表。**這是使用者會第一次看到差異的一步。**

會變的行為（要在 PR 說明裡列出來，並在畫面上準備好）：

| 變化 | 影響誰 |
|---|---|
| 客戶列表少了「來源」篩選 | CRM |
| 標籤字典變成唯一來源（沒有「字典外的標籤」了）| CRM、小香 |
| 報表存禮盒不存用料 | 報表、統計圖 |
| 改分類會改變歷史報表的分佈 | 統計圖 |
| 小香問庫存改打 CYBERBIZ API | 小香 |

⚠️ **同時要驗的三個工具回傳形狀**：`listTags`、`customerStats`、`loadWarehouse`。
每個都要有測試釘住。

⚠️ **`normalized_name` 的移除只能在 Phase 0 完成之後**。順序反了，改店名會
靜靜地把資料切成兩半。

---

## Phase 5：刪舊的（唯一有停機風險的一步）

`DROP TABLE` 與 `ALTER TABLE ... RENAME`。這一步的那一兩分鐘，舊 Worker 會 500。

**降到最低的做法**：

1. 排在離峰時段
2. **一次只刪一組**，每組之間隔一次部署
3. 刪之前再確認一次沒有任何程式引用（`grep` 舊表名，包含測試與
   `packages/tools`）
4. ⚠️ **絕對不要 DROP 被 CASCADE 指著的表**——見規則一的地雷清單。要刪的話
   先把子表的外鍵挪開

要刪的：`inventory_items`、`cyberbiz_product_links`、`custom_report_products`、
`product_sku_mappings`、`product_bundle_components`、`report_sku_ignores`、
`report_sales_monthly`、`report_manual_sales_monthly`、`report_manual_payout_daily`、
`report_scopes`、`payout_stores`、`payout_runs`、`cyberbiz_report_runs`、
`shopee_sales_settings`、`shopee_sales_runs`、`warehouse_settings`、
`warehouse_categories`、`zones`、`layout_elements`、`zone_images`、
`customer_tag_catalog`、`saved_views`、`cyberbiz_customer_webhooks`、
`cyberbiz_product_webhooks`、`report_product_categories`、
`cyberbiz_product_categories`、`cyberbiz_products`（改名後重建）

---

## Phase 6：收尾

- 移除 `packages/db` 裡的雙寫程式碼與過渡期註解
- 小香的 8 個工具跟著新的函式回傳形狀更新
- ➕ **webhook 事件的清理排程**（cron 已經每 15 分在跑，順手加一段）：
  ```sql
  DELETE FROM cyberbiz_webhook_events
  WHERE status IN ('processed','ignored') AND received_at < date('now','-30 days');
  ```
  失敗的**不要刪**——那是還沒解決的問題。
- 更新 `README.md` 的「下一步」與 `docs/` 裡受影響的設計文件

---

## 回滾

**Phase 1–3 可以直接回滾**（新表沒人讀，留著不礙事）。

**Phase 4 之後不能靠 migration 回滾**——資料已經只寫新表了。回滾的方式是
**部署上一版 Worker**，然後從備份補資料。

所以：

1. **Phase 4 之前一定要有一份 `wrangler d1 export` 的備份**，而且要驗證過
   它匯得回去（在 verify DB 上試一次）
2. Phase 5 之前再做一次

---

## 分工

**同一時間只能有一個人改 schema。** 這是這次最大的協作風險——兩個 agent 各自
跑 `pnpm generate` 會產生編號衝突的 migration（這件事這個 repo 已經發生過一次，
`0070` 撞號）。

建議：整個 Phase 1–5 由同一個 worktree 完成，另一邊只做 review。
