-- scopes 本來該是「payout_stores 與 report_scopes 合併成一張，一個 active 開關」
-- （見 docs/platform-schema-target.sql 的 scopes 段）。0078 實際做的是把兩張舊表
-- 各自複製進來，再用 source_type 記「從哪張舊表來的」：13 家店變成 26 列，同一家
-- 店有兩個 active，正是那份設計要消滅的狀態。
--
-- 而且 source_type 的值域錯了。設計寫的是「資料從哪個 driver 抓的」，值是
-- cyberbiz / shopee；正式庫填的是 report / payout。
--
-- 合併方向是留 report 那一列：所有事實表（report_item_sales_monthly、
-- report_payout_daily_target、report_run_scopes 共 8,115 列）都指著它，而且它的 id
-- 是有意義的 cyberbiz:store:<base64>，payout 那邊是 uuid。drive 設定則只有 payout
-- 那一列有，要先搬過去再刪。
--
-- 順序不能換：source_type 必須在刪掉重複列之後才改。先改的話兩列都會變成
-- cyberbiz，撞上 idx_scopes_source_normalized。

-- 1. drive 設定與排序只存在於 payout 那一列，先搬到要留下來的那一列。
UPDATE scopes AS keeper
SET drive_folder_url = (
      SELECT dropped.drive_folder_url FROM scopes AS dropped
      WHERE dropped.normalized_name = keeper.normalized_name AND dropped.source_type = 'payout'
    ),
    drive_folder_name = (
      SELECT dropped.drive_folder_name FROM scopes AS dropped
      WHERE dropped.normalized_name = keeper.normalized_name AND dropped.source_type = 'payout'
    ),
    sort_order = (
      SELECT dropped.sort_order FROM scopes AS dropped
      WHERE dropped.normalized_name = keeper.normalized_name AND dropped.source_type = 'payout'
    ),
    -- 兩個開關併成一個：任一邊停用就是停用。
    active = keeper.active * (
      SELECT dropped.active FROM scopes AS dropped
      WHERE dropped.normalized_name = keeper.normalized_name AND dropped.source_type = 'payout'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE keeper.source_type = 'report'
  AND EXISTS (
    SELECT 1 FROM scopes AS dropped
    WHERE dropped.normalized_name = keeper.normalized_name AND dropped.source_type = 'payout'
  );--> statement-breakpoint

-- 2. 兩邊都有的，刪掉 payout 那一列。只有 payout 有的（裕隆城）留著。
--    事實表全部指向 report 那一列，所以 RESTRICT 的外鍵不會擋。
DELETE FROM scopes
WHERE source_type = 'payout'
  AND EXISTS (
    SELECT 1 FROM scopes AS keeper
    WHERE keeper.normalized_name = scopes.normalized_name AND keeper.source_type = 'report'
  );--> statement-breakpoint

-- 3. 值域改回設計說的那一組：source_type 是 driver，不是舊表名。
--    id 前綴是唯一可靠的依據；payout 那邊留下來的是 uuid，那些是 CYBERBIZ POS 的店。
UPDATE scopes SET
  source_type = CASE WHEN id LIKE 'shopee:%' THEN 'shopee' ELSE 'cyberbiz' END,
  -- 蝦皮不是實體門市。scope_kind 的其他值先不動：總公司要不要變成 'company'
  -- 會改變公司查詢的加總方式，那是另一件事。
  scope_kind = CASE WHEN id LIKE 'shopee:%' THEN 'channel' ELSE scope_kind END,
  updated_at = CURRENT_TIMESTAMP;
