-- 手寫的資料搬移。CLAUDE.md 說「不要手改 migrations 裡的 SQL」，那條規則是
-- 防「改掉 drizzle 產的檔案造成 snapshot 與實際 schema 漂移」。這個檔案是
-- 額外加的、不動任何既有欄位定義，也不會被 drizzle 重新產生蓋掉。
--
-- 為什麼要有：customer_events 是稽核紀錄，正式站上已經有資料。drizzle 只會
-- 產「建新表」與「刪舊表」，中間這一段沒有人會幫我們寫——不寫的話，改版當下
-- 所有歷史紀錄就沒了。
--
-- 順序也是刻意的：0007 建表 → 0008 搬資料 → 0009 才刪舊表。三個分開才有中間
-- 那一步可以插。
INSERT INTO `activity_events` (
  `id`, `entity_type`, `entity_id`, `entity_label`, `event_type`, `summary`,
  `field`, `old_value`, `new_value`, `payload_json`,
  `actor_type`, `actor_id`, `actor_email`, `source`, `status`, `error`, `created_at`
)
SELECT
  e.`id`,
  'customer',
  e.`customer_id`,
  -- 名字取當下的客戶名當快照。客戶已經被刪掉的話 join 不到，留空字串。
  COALESCE(c.`name`, ''),
  e.`event_type`,
  e.`summary`,
  '',    -- field：CRM 記的是整包 payload，沒有欄位級的新舊值
  NULL,  -- old_value
  NULL,  -- new_value
  e.`payload_json`,
  e.`actor_type`,
  e.`actor_id`,
  e.`actor_email`,
  e.`source`,
  e.`status`,
  e.`error`,
  e.`created_at`
FROM `customer_events` e
LEFT JOIN `customers` c ON c.`id` = e.`customer_id`;
