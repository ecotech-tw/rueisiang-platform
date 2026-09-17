-- 0161／0162 會 DROP 獎金池那四張表。正式環境在寫這支時四張表都是 0 筆，但部署當下
-- 無法保證沒有人透過 API 寫進資料，而 DROP 不可逆。
--
-- 這支是閘門：四張表有任何一筆資料，CHECK 就會失敗，D1 整支 migration 包在同一個
-- 交易裡，因此回滾並讓部署停在這裡，後面兩支 DROP 不會執行。遇到的話先把資料匯出或
-- 確認可以捨棄，再手動清空後重新部署。
CREATE TABLE `_guard_bonus_pool_empty` (`row_count` integer NOT NULL CHECK (`row_count` = 0));--> statement-breakpoint
INSERT INTO `_guard_bonus_pool_empty` (`row_count`)
SELECT (SELECT count(*) FROM `hr_bonus_pools`)
     + (SELECT count(*) FROM `hr_bonus_allocations`)
     + (SELECT count(*) FROM `hr_bonus_revenue_snapshots`)
     + (SELECT count(*) FROM `hr_bonus_performance_snapshots`);--> statement-breakpoint
DROP TABLE `_guard_bonus_pool_empty`;
