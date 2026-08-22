-- 資料搬移：把既有紀錄的 `assistant_key` 複製成 `channel_key`。
--
-- drizzle 只會產「加欄位」與（下一支）「換主鍵」，中間這段沒有人會幫忙寫，不寫就是
-- 讓 0023 的 NOT NULL 直接炸掉，或把既有的 LINE 群組與訊息全部變成孤兒。
--
-- 為什麼兩個 key 的值一樣：現在只有小香一個 assistant、一個 channel，兩者一對一。
-- 值相同不代表概念相同——0023 之後 `channel_key` 才是關聯用的鍵值，官網客服進來時
-- 只會新增 channel 列，既有資料不必再搬一次。
--
-- 全部用 WHERE ... IS NULL 保護，重跑不會蓋掉已經寫好的值。
UPDATE `assistant_line_channels`
SET `channel_key` = `assistant_key`
WHERE `channel_key` IS NULL;--> statement-breakpoint

UPDATE `assistant_line_groups`
SET `channel_key` = `assistant_key`
WHERE `channel_key` IS NULL;--> statement-breakpoint

UPDATE `assistant_line_messages`
SET `channel_key` = `assistant_key`
WHERE `channel_key` IS NULL;--> statement-breakpoint

-- 既有的執行紀錄補上是哪個 bot 跑的。
--
-- 只有在「剛好一個 channel」的時候才成立，所以用子查詢限定；多於一列時 WHERE 會擋下來，
-- 寧可留空也不要亂猜——用量分析寧願少一段歷史，也不要有一段是錯的。
UPDATE `assistant_runs`
SET
  `assistant_key` = (SELECT `assistant_key` FROM `assistant_line_channels` LIMIT 1),
  `channel_key` = (SELECT `channel_key` FROM `assistant_line_channels` LIMIT 1)
WHERE `assistant_key` IS NULL
  AND (SELECT COUNT(*) FROM `assistant_line_channels`) = 1;
