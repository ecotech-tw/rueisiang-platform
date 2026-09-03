# Platform schema 重整：決策紀錄

這份文件記錄「為什麼要這樣改」。**改成什麼樣**看
[`platform-schema-target.sql`](./platform-schema-target.sql)，**怎麼改上去**看
[`platform-schema-migration-plan.md`](./platform-schema-migration-plan.md)。

輸入是 `rueisiang-platform-codex/docs/platform-target-schema.sqlite.sql`
（草案，62 張表）。逐表對照現況（51 張）之後的結論：**第一階段保留 31 張**，
小香的 18 張（`assistant_*`）第一階段完全不動。

---

## 這次重整要解決的三件事

### 1. 商品有三個身分空間

現在同一個商品可能同時是 `inventory_items`（WMS）、`cyberbiz_products`（官網鏡像）、
`custom_report_products`（報表自訂）三筆資料，靠 `cyberbiz_product_links` 與
`product_bundle_components` 的三個互斥外鍵串起來。

`packages/db/src/wms-sync.ts` 的三條不變條件裡有兩條是在防這件事（product_id
對不上、SKU 對不上）。身分統一成 `items` 之後，**那兩條防線不是被修好，是不再
可能發生**——這是重整的實質收穫，不只是改名。

### 2. 同一件事散在好幾張表

| 現況 | 之後 |
|---|---|
| `report_sales_monthly` + `report_manual_sales_monthly` | `report_item_sales_monthly`（`record_origin`）|
| `report_payout_daily` + `report_manual_payout_daily` | `report_payout_daily`（同上）|
| `product_sku_mappings` + `report_sku_ignores` | `report_external_products`（`resolution`）|
| `cyberbiz_report_runs` + `payout_runs` + `shopee_sales_runs` | `report_runs` |
| `cyberbiz_customer_webhooks` + `cyberbiz_product_webhooks` | `cyberbiz_webhook_events` |
| `report_scopes` + `payout_stores` + `shopee_sales_settings` | `scopes` |

每一組拆開的兩張表 UNIQUE 鍵都一樣，**結構上擋不住互相矛盾的兩列**。
`cyberbiz_report_runs.report_kind` 已經有 `'payout'` 了，卻還有一張
`payout_runs`——同一個按鈕寫兩張表，那是現存的 bug，只是還沒有人發現對不起來。

### 3. 幾何、標籤、店別各有兩份真相

- `zones` 與 `layout_elements` 各存一份 x/y/w/h → 兩套拖曳邏輯
- 標籤存在 `customers.cyberbiz_tags_json`，字典在 `customer_tag_catalog` → 程式要聯集
- 店別在 D1，driver 讀 `tools/cyberbiz-reports/stores.json` → `schema/tools.ts:18`
  的註解自己承認「在這裡新增一家帳務 repo 沒有的店，執行時會失敗」

---

## 貫穿全部決定的幾條判準

這些在逐表討論裡反覆出現，寫在前面就不用每張表重講一次。

**A. 沒有消費者的欄位不留。**
`last_webhook_at`（只寫不讀）、`result_json`（只寫不讀）、`trigger_kind`（報表
只有手動）、`d1_import_eligible`（就是 `period_kind === 'month'`）全部因此拿掉。

**B. log 已經有的不要再存一份。**
`activity_events` 記了每一次變更的 `field` / `old_value` / `new_value` / `created_at`
與作者。所以 `created_by`、`sync_error`、`last_error`、兩張 `*_sync_runs`
都不需要。**唯一的例外是畫面上直接顯示的**——`ManualReports.tsx:1474` 渲染
`updated_by_email`，改成 join 的話一頁 20 列要查 20 次，所以那一欄留快照。

**C. 「有哪些 X」是程式碼還是資料？**
CLAUDE.md 已經有這條規則：權限鍵值寫在程式碼，不寫在資料表。**報表來源同理**——
新增一個來源要寫 workflow + driver + route 並開 PR，從來就不是「插一列」。
所以 `report_sources` 表刪掉，改成 `scopes.source_type` 一欄，唯一來源是
TS 的 `ReportSourceType`。

**D. 只有兩三列的表不是抽象，是儀式。**
`report_sources`（兩列）、`wms_settings`（一列）都會讓底下每張表多一個外鍵、
每個查詢多一次 join、每個測試多一筆種子資料。

**E. 互斥的兩個狀態要綁在 CHECK 裡。**
`resolution='mapped'` ⇔ `item_id IS NOT NULL`、`record_origin='imported'` ⇔
`report_run_id IS NOT NULL`。不綁的話就會出現「說是對應好了但指向 NULL」這種
畫得出來但沒有意義的資料。

**F. 草案整份 0 支索引。**
`grep -c "CREATE INDEX"` 的結果是 0。目標 SQL 每張表的索引都是照現況查詢重新
推導的，不是照抄。

---

## 逐表決定

編號是草案檔案裡的順序。

### 權限（#1–#9）：9 張 → 5 張

| # | 表 | 決定 |
|---|---|---|
| 1 | `users` | ✅ 照搬。`name` → `google_name`：跟 `display_name` 放一起時看不出哪個是使用者能改的 |
| 2 | `roles` | ✅ `key` → `role_key`，補 `updated_at`（搬資料時用 `created_at` 回填）|
| 3 | `access_policies` | 🗑️ **刪**。ABAC 沒有需求，而且與「權限不寫在資料表」直接衝突 |
| 4 | `role_permission_grants` | ✅ 主鍵回 `(role_id, permission)`，補 CASCADE |
| 5 | `user_role_assignments` | ✅ 主鍵 `(user_id, role_id)`，**不留 scope_type / scope_id** |
| 6 | `user_role_attributes` | 🗑️ 刪（#3 沒了，FK 目標不存在）|
| 7 | `user_permission_grants` | ✅ 主鍵 `(user_id, permission)`，補 CASCADE |
| 8 | `user_permission_grant_attributes` | 🗑️ 刪（同 #6）|
| 9 | `user_attributes` | 🗑️ 刪。要記員工屬性應該在 `users` 加有型別的欄位，不是 key/value 袋 |

**#5 為什麼敢拿掉 scope**：`packages/auth/src/rbac.ts:47` 的註解說得很清楚，
`can()` 沒有 scope 參數——那兩欄從來沒有被檢查過。留著一個沒有人檢查的欄位
比沒有更危險，它讓人以為權限已經按店別隔離了。

### 檔案（#10）

`media_objects` ✅ 留。➕ `storage_provider DEFAULT 'nas'`。

索引只留一支 partial：`(expires_at) WHERE expires_at IS NOT NULL`。查過
`packages/db/src/media.ts`（全部 53 行），`namespace` 與 `scope_key` 兩支
**沒有任何查詢用得到**——列某個倉位的照片是查 `wms_zone_images`，不是回頭掃
這張表。

📌 既有問題：孤兒檔沒人清（上傳成功但沒被任何東西引用）。這一輪不處理，
但 `wms_zone_images` 加了 FK 之後至少方向對了。

### 商品（#11–#15）：5 張 → 4 張，全部改名

**最大的一個決定：`products` → `items`。**

使用者的原話：「那是不是就不應該叫做 products 了...? 某種程度上它違反了命名。
不過我在 cyberbiz 商品列表的確也有看到一些盤點庫存用的（例如：紅紙袋）」。

裡面會有包材與備品，叫 products 會騙人。連帶 `product_categories` →
`item_categories`、`product_components` → `item_components`、`wms_products` →
`wms_items`。

| # | 表 | 決定 |
|---|---|---|
| 11 | `item_categories` | ✅ ➕ `parent_id` **固定兩層** RESTRICT、`sort_order`、`active`。UNIQUE 改 `(parent_id, name)`。「未分類」= NULL，不做成資料列 |
| 12 | `items` | ✅ **樞紐表**。代理 `id` ＋ `UNIQUE (source, sku)`。`list_price` 留（手動報表自動帶入）|
| 13 | `cyberbiz_products` | ✅ 改成 `item_id` 當主鍵的延伸表。❌ `inventory_quantity` |
| 14 | `custom_products` | 🗑️ **刪，攤平到 `items`**。`notes` / `created_by` 都不要（log 已有）|
| 15 | `item_components` | ✅ **四個外鍵收成兩個**。➕ `CHECK(parent<>component)`、`CHECK(quantity>0)` |

#### `items` 的兩個獨立軸

| 欄位 | 意思 | 誰能寫 |
|---|---|---|
| `source` | 身分從哪來（cyberbiz / custom）| **不可變**，是歷史事實 |
| `kind` | 拿來做什麼（sellable / supply）| **只有我們**，同步不可覆寫 |

使用者問過：「假設日後我想要拉回來系統控管，可以直接把同步回來（例如：紅紙袋）
的 item 改成 `source='custom'`，然後 cyberbiz 就可以棄用了，對嗎？」

**不行，而且不需要。** `source` 是歷史事實不該改。要改的是 `kind`
（`sellable` → `supply`）跟在官網下架。兩個軸分開就是為了這個。

#### 同步的所有權規則（等級同 `crm-sync.ts` 的四條）

1. `items.name` 只在**建立時**從官網帶入，之後同步**不覆寫**
2. `items.kind` / `active` / `category_id` **只有我們寫**
3. 官網那一面的名稱與上下架寫在 `cyberbiz_products`
4. 新同步進來預設 `kind='sellable'`——分錯看得見；反過來會默默消失在報表裡

#### 為什麼 `inventory_quantity` 不進 D1

多輪討論後由使用者定案：

> 商品本身在 cyberbiz products 就有庫存數量跟水位這件事！
> ⋯⋯第一直覺會去 redis 拿阿

每筆訂單都會變，存進 D1 就是一份一定會過期的假資料，而且**沒有任何 SQL 需要
join 它**。要庫存就即時打 CYBERBIZ API（Redis 快取）。

#### 為什麼同步狀態全放 `cyberbiz_products`

使用者的論證（我接受）：

> `sync_status` 從來就不是只有「庫存同步」這件事而已，像是產品重新命名、
> 標籤更新等等。而 join 這件事，原則上你要渲染出所有的倉庫地圖以及取得所有
> 資訊就要去 join 一次 items → cyberbiz_products 了，根本不會有重複 join 的發生

所以 `wms_items` 完全沒有 CYBERBIZ 欄位。乾淨。

### WMS（#16–#25）：10 張 → 7 張

| # | 表 | 決定 |
|---|---|---|
| 16 | `wms_categories` | ✅ ➕ `active`。❌ 不加 `parent_id`（作業分類不需要階層）|
| 17 | `wms_zones` | ✅ ➕ `active`。❌ `category`（與品項分類漂移）、❌ `zone_type`（無查詢）。幾何 → #20 |
| 18 | `wms_shelves` | ✅ **要做**——層要被 `wms_items.shelf_id` 指到就必須有 id。四欄收成 `code + name + sort_order` |
| 19 | `wms_layouts` | ✅ 留（會有第二張地圖）。❌ `is_default` |
| 20 | `wms_layout_elements` | ✅ **幾何統一到這一張**，這區最好的改善。➕ `z_index`、➕ CHECK 綁 `element_type` 與 `zone_id` |
| 21 | `wms_settings` | 🗑️ **刪**。只剩 `default_layout_id`，而程式 query limit 1 就夠 |
| 22 | `wms_items` | ✅ `shelf_id` **nullable**、**不留 zone_id**（倉位由層推導）|
| 23 | `wms_stock_levels` | 🗑️ **刪**。使用者：地圖管理時不需要知道每個 shelf 有多少商品 |
| 24 | `wms_cyberbiz_sync_states` | 🗑️ **刪**。身分統一後連結是隱含的，不需要對應表 |
| 25 | `wms_zone_images` | ✅ 縮成純連結表。舊版把 `filename` / `content_type` / `size` 從 `media_objects` 抄了一份 |

#### `wms_items` 不是每個 item 都要有一列

使用者確認過：「以現在的服務來說，我是不是不一定要新增 `wms_products`，等到有
新商品或是自訂商品新增後，我可以自己新增放到貨架上？」

**對。** 官網新商品同步進來時只有 `items`，等有人真的把它放上貨架才建
`wms_items` 的列。「有沒有進倉庫」= 這張表有沒有該 `item_id`。

#### 盤點的方向是反的

使用者說明實務：「他們盤點也是會去 cyberbiz 更新，再由 cyberbiz 同步回 wms，
方向上是相反的。」

所以 `wms_items.quantity` 對官網有的品項是**鏡像值**，對自製材料與包材是
**唯一紀錄**。送 quantity 失敗記在 log，不需要欄位。

### CRM（#26–#30）：5 張 → 4 張

| # | 表 | 決定 |
|---|---|---|
| 26 | `crm_customers` | ✅ CYBERBIZ 欄位**攤平進來**。❌ `source_channel`、`last_webhook_at`、`sync_error`、`cyberbiz_tags_json` |
| 27 | `cyberbiz_customers` | 🗑️ **不做延伸表** |
| 28 | `crm_tags` | ✅ 照留，改名自 `customer_tag_catalog` |
| 29 | `crm_customer_tags` | ✅ **要做**。標籤從 JSON 字串陣列改成關聯表 |
| 30 | `crm_saved_views` | ✅ 留，但**退回具名欄位**。❌ `filters_json`、`channel`、`created_by_id` |

#### 產品決策：不再支援 manual 客戶

review 時發現 `apps/api/src/routes/crm.ts:120` 有明確的
`sourceChannel !== "manual"` 分支，而且 `crm-sync.ts` 的四條不變條件裡有一條
就是在保護它。使用者的決定：

> 應該不會有只有 local only 的可能性，建立就是只有 post 到 cyberbiz，
> 然後 cyberbiz 新增成功會 webhook 打回來而已

於是 `cyberbiz_customers` 變成「必定存在的 1:1 延伸表」→ 沒有存在意義 →
攤平。而 `cyberbiz_customer_id` 是否為 NULL 本身就取代了 `source_channel`。

⚠️ **這是行為變更，要另開 PR**：建立客戶改成非同步（POST 官網 → 等 webhook），
而且要處理「webhook 沒回來」的補撈，否則官網建成功但我們永遠沒有這筆。

#### 為什麼 `saved_views` 不用 JSON

草案把 `search` / `channel` / `status` / `tag` 壓成 `filters_json`，這是退步：
篩選條件改名時 JSON 版本會**默默壞掉**（舊視圖套用後沒反應），具名欄位則是
型別會爆。JSON 唯一的好處是「新增篩選不用 migration」，但這個專案本來就常跑
`pnpm generate`。

### 報表（#31–#38）：8 張 → 7 張，但取代了現況的 12 張

| # | 表 | 決定 |
|---|---|---|
| 31 | `report_sources` | 🗑️ **刪** → `scopes.source_type` 一欄 |
| 32 | `scopes` | ✅ 三處合併，去掉 `report_` 前綴。➕ `scope_kind = 'channel'` |
| 33 | `report_external_products` | ✅ 合併 mappings + ignores。身分**拆兩欄** |
| 34 | `report_runs` | ✅ 三張併一張。`report_kind` enum → **兩個旗標** |
| 34b | `report_run_scopes` | ✅ 新增子表取代 `stores_json` |
| 34c | `report_run_reports` | ✅ **新增**（草案沒有）|
| 35 | `report_item_sales_monthly` | ✅ 兩張併一張。**五個 snapshot 全拿掉** |
| 36 | `report_product_component_usage_monthly` | 🗑️ **刪** |
| 37 | `report_payout_daily` | ✅ 兩張併一張 |
| 38 | `report_ingest_issues` | ✅ **要做** |
| — | `report_run_files` | 🗑️ **先不做** |

#### #32 為什麼不叫 `stores`

使用者問過。答案跟 `products → items` 是同一個：這張表裡會有蝦皮、momo、
官網、全公司彙總，叫 `stores` 就是同一個命名坑。

去掉 `report_` 前綴是對的——它會被 WMS 與 CRM 用到，屬於平台共用層，跟
`users` / `items` / `media_objects` 同一級。

#### #32 為什麼要 `source_type` 與 `scope_kind` 兩欄

使用者問：「如果我要出金或是銷售報表是不是會 filter
`source_type = 'cyberbiz' and scope_kind = 'store'`？」

**對，而且那正是重點。** 兩欄回答不同問題：

| 頁面 | filter | 為什麼 |
|---|---|---|
| 執行頁 | `source_type` **和** `scope_kind` | 出金 driver 只開得了 CYBERBIZ POS，跑不了官網也跑不了蝦皮 |
| 統計頁 | **都不 filter** | 「通路銷售額比較」要門市＋蝦皮＋momo＋官網全部一起比 |

⚠️ 如果日後發現這一對到處都寫在一起，那是訊號——代表真正想要的是第三個概念
（「哪個 driver 跑得動這個 scope」）。**現在還推導得出來，不要先做。**

#### #33 為什麼身分要拆兩欄

蝦皮的外部 SKU 是「商品ID_規格ID」，舊 mapping 只有商品ID
（`product-sku-mappings.ts:747` 的註解）。黏成一個字串之後，每個查詢都要自己
`indexOf("_")` 切一次——`legacyShopeeExternalSku` **有四個呼叫點**
（`:752`、`:932`、`:1045`、`report-data.ts:557`），漏一個就默默對不到。

拆成 `external_key` + `external_variant_key` 之後，「精確優先、退回商品層級」
變成一句 SQL。用 `''` 不用 NULL：SQLite 的 UNIQUE 把每個 NULL 當成不同值。

#### #33/#36 組合包的模型

由使用者定案，比草案好：

> 1. 只統計禮盒：不需要特別寫 `item_components`，report 會直接拉出單獨的項目
> 2. 將禮盒拆散到不同 item：⋯⋯report 一樣可以統計禮盒，但我有完整的紀錄
>    且不影響統計

**報表永遠只存賣出去的那個 item。** `item_components` 是 BOM 定義，不進報表，
所以不會重複計算。兩種用法共用同一結構，差別只在 BOM 有沒有填。

連帶收穫：
- `product_bundle_components` 整張刪掉（含它的三個互斥外鍵）
- 匯入不再展開用料 → `product-sku-mappings.ts` 的 `resolveComponents` 那一整套
  （含批次查、蝦皮別名回退）可以拿掉
- 同一個禮盒在官網與蝦皮都賣時，組成只定義一次

#### #35 為什麼不存 snapshot（選 A）

草案有五個 snapshot 欄位。拿掉的理由：

1. 使用者要的是「大分類展開看小分類」。snapshot 版本要**連父帶子抄兩欄**，
   改分類階層時歷史就對不上
2. 同一個商品在報表裡出現兩個名字，同仁會以為是兩個商品
3. `unit_price` = `sales_amount ÷ net_quantity`，本來就算得出來

⚠️ **代價**：改分類會回頭改變歷史報表的分佈。內部分析可接受；要拿去對帳的話
這個決定要重新討論。

使用者接著問：「假如日後我商品改名字，但我報表希望用的是舊的資料，那該怎麼辦？
是不是 item 也要有另外一張表去記錄更動？」

**不用開新表。** `activity_events` 已經有
`entity_type / entity_id / field / old_value / new_value / created_at`
與索引 `(entity_type, entity_id, created_at)`，使用者想的那句查詢直接可跑：

```sql
SELECT new_value FROM activity_events
WHERE entity_type = 'item' AND entity_id = ?
  AND field = 'name' AND created_at < '2025-08-31'
ORDER BY created_at DESC LIMIT 1;
```

**而且售價根本不受影響**——報表存的是 `sales_amount`（實際成交），`list_price`
只是手動輸入時的預設值。

**目前不做這個查詢**：改名多半是修正（用舊名會讓趨勢圖裂成兩條、永遠留著錯字），
真的換商品應該開新 item 並把舊的 `active=0`。而且 log 一直在累積，
**隨時可以補做**——不是現在不做就永遠沒有。

#### #35 效能：join vs IN vs subquery

使用者問過。答案：

| 做法 | 5000 列報表讀到的 rows |
|---|---|
| 相關子查詢 | ❌ 最貴，每列跑一次 |
| `JOIN items` | 5000 + 5000（同一列 items 被重複讀約 17 次）|
| 程式 `WHERE id IN (...)` | 5000 + 300（去重）|
| **`items` 字典整份快取 Redis** | ✅ **5000 + 0** |

📌 **但先做最簡單的 JOIN**：分析結果已經快取 24 小時
（`apps/api/src/report-cache.ts:11`），成本一天付一次；實測（`wrangler d1 insights`）
排進前幾名再換。分類篩選沒有結果快取可靠，那裡才需要從快取字典算出 item ids
再 `IN (...)`，分批照 `product-sku-mappings.ts:759` 的 `SKU_LOOKUP_BATCH_SIZE`。

#### #34 為什麼用兩個旗標不用 enum

蝦皮一次做銷售與出金兩種（`packages/tools/src/index.ts:98`
`reportKind: isShopee ? "sales_and_payout" : reportKind`）。

用 enum 的話每個「這次有沒有銷售」的判斷都要寫成 OR——
`cyberbiz-report-ingest.ts` 已經重複了四次
`kind === 'sales' || kind === 'sales_and_payout'`，漏一個就漏掉蝦皮。
兩個旗標之後查詢是 `WHERE imports_sales = 1`，一個條件。

#### #34c 為什麼新增 `report_run_reports`（草案沒有）

driver 的執行報告 `.md` 現在只存在 GitHub Actions 的 artifact 裡，
**90 天過期**——而出金表動的是正式帳務的 Drive 檔案，「去年 8 月那次跑了什麼」
必須查得到。

做成 1:1 側表而不是 `report_runs` 的欄位：執行清單頁不需要它，放主表會讓每次
列清單都拖著整份 markdown。

#### 為什麼不做 `report_run_files`（草案有）

它是純連結表，之後加跟現在加一樣便宜，**現在做只會多一張永遠空著的表**。

而且報表檔案現在的家是 **Google Drive**（永久），`media_objects` 只管我們 NAS
上的檔案，連不到 Drive。`nas-storage.ts:172` 的 `reports` namespace 驗證已經
備好，但**找不到任何呼叫端**。

📌 **回頭做它的觸發條件**：一年出現兩三次以上「失敗了但看不出原因」→
截圖才有長期價值。

### CYBERBIZ 事件（#39–#41）：3 張 → 1 張

| # | 表 | 決定 |
|---|---|---|
| 39 | `cyberbiz_webhook_events` | ✅ 兩張併一張，🎁 順便補上商品那邊漏掉的 `payload_json` |
| 40 | `cyberbiz_product_sync_runs` | 🗑️ **刪** |
| 41 | `cyberbiz_customer_sync_runs` | 🗑️ **刪** |

#40/#41 是純 log（`activity_events` 已涵蓋），而且**連 cursor 欄位都沒有**，
解不了「分批同步跑到第幾頁」這個真正的痛點。

真的要自動續跑的話需要的是游標不是執行紀錄：
`cyberbiz_sync_cursors(entity_type PK, next_page, started_at, updated_at)`，
一種 entity 一列。⚠️ 但那是行為變更（會不會跟手動同步打架、要不要停止鈕），
使用者決定**先不做**。

### 共用（#42）

`activity_events` ✅ **照搬**，欄位與現況完全一致。要補回四支索引。

⚠️ **不可設過期清理**——它是「商品當時叫什麼」的唯一來源。

### 小香（#43–#60）：第一階段不動

相依檢查結果：

**表本身不相依。** 18 張裡指向外面的只有 `created_by` / `updated_by` /
`actor_id` → `users(id)`，而 `users` 這一輪維持原樣。

**但工具層相依很深。** `packages/tools/src/index.ts` 的 10 個工具有 8 個會被
掃到（`wms_list_inventory`、`wms_search_warehouse`、`wms_get_inventory_item`、
`wms_list_low_stock_items`、`wms_get_activity`、`crm_search_customers`、
`crm_get_customer`、`query_sales_report`、`query_payout_report`）。

🎁 **但小香不直接查表**，它呼叫 `packages/db` 的具名函式——這正是 CLAUDE.md
「業務邏輯放在 `packages/db`」那條規則的回報。**只要函式的回傳形狀不變，
小香一行都不用改。**

⚠️ 三個形狀一定會變，各要一個測試釘住：

| 函式 | 變什麼 |
|---|---|
| `listTags` | `TagRow.inCatalog` 消失（字典變成唯一來源）|
| `customerStats` | 「來源」統計消失（不再有 manual）|
| `loadWarehouse` | `quantity` 改走 CYBERBIZ API |

最後一個**最需要小心**：小香回答「還有幾個」時從查 D1 變成打外部 API，
逾時與失敗要有明確回話，不能卡住或亂編數字。

---

## 這一輪刻意**不做**的事

寫在這裡是為了讓下一個人知道它們被考慮過。

- **禮盒銷量可見度**：報表改存禮盒之後，2025 年以前的歷史只有用料層級。
  要補的話得接受斷點，而且要在畫面上講清楚。
- **商品改名的時光旅行**：資料在 `activity_events` 裡，隨時可以補做。
- **分批同步自動續跑**：需要游標表 + 行為決策。
- **報表檔案搬進 NAS**：見 `report_run_files` 那一段。
- **webhook 事件的清理排程**：見 migration plan 的收尾清單。

---

## 已知的既有問題（這一輪不修，但記著）

- 🐛 `apps/portal/src/routes/crm/SavedViewBar.tsx:78` 用原生 `title=`，
  違反 CLAUDE.md 的 tooltip 規則，應改用 `ui/Tooltip.tsx`
- ⚠️ `media_objects` 的孤兒檔沒人清
- ⚠️ `cyberbiz_*_webhooks` 只進不出
- ⚠️ `cacheClient` 不可注入，所以快取失效沒辦法寫測試（已經因此漏掉兩個
  invalidation bug）
