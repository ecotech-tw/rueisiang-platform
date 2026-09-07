# Platform schema migration plan

這份文件描述平台 schema migration 的執行規則與驗證方式。target contract 見
[`platform-schema-target.sql`](./platform-schema-target.sql)，設計取捨見
[`platform-schema-overhaul.md`](./platform-schema-overhaul.md)。

## 範圍

第一階段的 target contract 是非小香部分 32 張表；小香的 15 張 `assistant_*` tables
維持既有形狀。WMS 庫存同步使用 `wms_items` 與 `cyberbiz_products` 透過 `items.id`
隱含對應；CYBERBIZ 會員與商品／庫存事件共用 `cyberbiz_webhook_events`，因此不能用原本的
32 + 15 推斷目前實體表數量。

商品事件的外部身分放在 `external_entity_id`（variant_id），原始內容放在
`payload_json`。接收、事件分類、重試與 retention 都只讀這張共用事件表；不能再讓
WMS 維護另一套 webhook event store。

本輪採一次上線，不做 expand/contract 或長期雙寫。Breaking change 必須在維護窗口
內套用，並以正式資料備份完成本機重播與 parity 驗證後才可進入 deploy。

## 不可違反的 migration 規則

### 1. Migration 以 D1 transaction 執行

正式 deploy 由 `.github/workflows/deploy.yml` 的 `ubuntu-latest` 執行，順序是：

```
pnpm test → pnpm build → D1 migrations apply → Worker deploy → health check
```

Migration 內不要使用 `PRAGMA foreign_keys = OFF` 保護重建。D1 會把 migration 包在
transaction 中，而 transaction 內切換 `foreign_keys` 沒有效果；被 `ON DELETE CASCADE`
指向的父表若直接 `DROP TABLE`，可能連坐刪除子表資料。這不是理論風險：舊的
`0023` 曾在正式環境刪除 `assistant_line_groups`，後續以
`0028_restore_line_groups.sql` 復原；因此本機逐句執行通過，不代表 D1 transaction
中的 `DROP TABLE` 安全。

### 2. 改名與資料搬移分開處理

- 改名使用手寫 `ALTER TABLE ... RENAME TO` 或 `RENAME COLUMN`。
- Drizzle 產生的建表／刪表 SQL 必須逐支 review，看到不必要的 `DROP TABLE` 就停止。
- `INSERT INTO target SELECT ... FROM legacy` 另放資料搬移 migration，不能假設 Drizzle
  會替我們保留歷史資料。
- 搬移時只能寫入 target ID；legacy ID 不得寫入 target foreign key。
- 需要跨 migration 使用的對照資料要使用持久化的 migration table，不使用 TEMP table。

### 3. 父子表要先處理相依

本輪特別要注意：

| 父表／來源表 | 相依表 | 正確順序 |
|---|---|---|
| `cyberbiz_products` | `cyberbiz_product_categories` | 先搬分類，再移除來源表 |
| `zones` | `zone_images` | 先建立 `wms_zone_images`，再移除來源表 |
| `roles`／`users` | 授權與角色指派表 | 先完成 target 資料與 consumer 切換 |
| `inventory_items` | `cyberbiz_product_links` | 先搬 `items` 與 WMS link，再移除來源表 |

## Migration registry

實際檔名、順序與 production 是否已套用，以
`packages/db/migrations/`、`packages/db/migrations/meta/_journal.json` 與 D1 的
`d1_migrations` 為準。本輪相關 migration 為：

```
0074_permissions_auth_rename
0075_crm_rename_foundation
0076_items_wms_foundation
0077_media_storage_provider
0078_report_scopes_foundation
0079_report_legacy_backfill
0080_report_payout_target
0081_report_external_products_backfill
0082_wms_layout_shelf_backfill
0083_cyberbiz_product_identity
0084_report_external_mapping_backfill
0085_report_bundle_target_backfill
0086_wms_cyberbiz_links_target
0087_wms_orphan_image_cleanup
0088_drop_migrated_legacy_schema
0089_item_wms_permissions
0089_z_merge_duplicate_sku_items
0090_items_sku_unique
0091_align_index_names
0092_item_categories_constraints
0093_schema_single_definition
0094_drop_roles_legacy_key
0095_crm_target_cutover
0096_merge_scopes
0097_webhook_events_entity_type
0098_cyberbiz_item_name_dedupe
0099_permission_grants_fk
0100_rename_payout_daily
0101_activity_entity_type_rename
0110_drop_legacy_rbac_tables
0111_drop_payout_stores
0112_cyberbiz_webhook_events_unify
0113_wms_cyberbiz_identity_cutover
```

`0097_webhook_events_entity_type` 先補上共用事件表的 `entity_type` 約束；`0112` 完成
會員與商品事件的 unified cutover；`0113` 再將 WMS 商品身分切換到 `items` 的延伸表。

`0101_activity_entity_type_rename` 只用一支 `UPDATE` 將 `activity_events.entity_type` 的
四個舊值改成 target 值，保留 `entity_id` 與其他欄位，不重建資料表。

`0111_drop_payout_stores` 刪除前會先把 0096 之後可能異動的 Drive 目標、排序與啟用狀態
同步回 `scopes`；之後出金與商品銷售執行頁也改讀 `scopes`。

## 驗證與量測

### 本機

本機使用 `apps/api/src/local-d1/d1.ts` 的 `node:sqlite` 跑 migration 與測試，輸入應使用
最新核准的正式資料匯出檔；空庫 fixture 只能補充驗證 schema 行為。這只能驗證 SQL、
foreign key、資料搬移與 runtime 行為，不能代表 production D1 的執行時間。

這台開發機是 Windows on ARM，沒有可用的 `workerd`。**不要在本機執行任何
`wrangler` 指令**，包含 `d1 export`、`d1 execute`、`d1 migrations apply`、`deploy`
與 `--dry-run`。

### Production D1

正式資料只能透過 `.github/workflows/d1-query.yml` 做唯讀檢查。該 workflow：

- 只接受 `SELECT`、`WITH`、`PRAGMA`。
- 不得輸出客戶電話、Email 或其他個資。
- 驗證查詢集中放在 `docs/d1-verify-queries.sql`。
- 查詢結果與執行紀錄留在 GitHub Actions log。

### 備份還原與完整量測

verify D1 不是每次 production deploy 的前置條件。需要測試備份可還原或量測完整
migration 時，才在 `ubuntu-latest` workflow 建立 verify D1、匯出 production、依 foreign
key 拓撲整理匯出檔，再執行還原。匯出檔的 INSERT 順序不保證符合外鍵相依順序。

## Deploy 與 rollback

1. 在 Linux CI／workflow 完成備份與必要的 verify 還原。
2. 公告維護窗口；時間以真資料環境的量測為準。
3. Merge 後由 `deploy.yml` 套用 D1 migration、部署 Worker 並執行 health check。
4. 透過唯讀 D1 workflow 執行 schema、foreign key 與資料 parity 查詢。
5. 執行客戶列表、WMS 地圖／庫存、商品銷售報表、出金報表的人工 smoke test。

Migration 沒有 migration-level rollback。若套用失敗或資料驗證不符：

1. 依已驗證的 Linux CI／Cloudflare D1 流程還原備份。
2. 部署上一版 Worker。

## 後續 schema 變更

後續要移除 compatibility table 或合併 webhook 時，必須先完成所有 consumer 的讀寫
切換與 parity 驗證，再另開 migration。不要把目前仍被 runtime 使用的舊表直接列入
`DROP TABLE`。

同一時間只能有一個 worktree 產生 schema migration。涉及 schema 的新 migration 應先修改
`packages/db/src/schema/` 與測試，再由 Drizzle 產生；純資料更新則手寫 SQL 並補 D1-style
migration test。既有 migration 不直接修改。
