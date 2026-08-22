-- 資料復原：把被 0023 誤刪的 LINE 群組從訊息與執行紀錄裡撈回來。
--
-- 出事的原因：0023 重建 assistant_line_channels 時靠 `PRAGMA foreign_keys=OFF` 保護，
-- 但 D1 是用 `wrangler d1 migrations apply` 把整支 migration 包在 transaction 裡送出，
-- 而 **PRAGMA foreign_keys 在 transaction 裡是 no-op**（SQLite 的規格）。所以外鍵稽核
-- 其實一直開著，DROP TABLE 父表就把 assistant_line_groups 全部連坐刪光了。
--
-- 本機的 migration runner 是一句一句跑、沒有 transaction，PRAGMA 有生效，所以本機與
-- 測試都看不出問題——這正是它逃過測試的原因。
--
-- 還救得回來的是「有哪些群組」：assistant_line_messages 沒有外鍵，沒有被連坐，
-- 它的 line_group_id 就是曾經標註過小香的群組。assistant_runs.group_id 也記著同一件事。
--
-- 救不回來的是 display_name 與 enabled——那兩個只存在被刪掉的那張表裡。所以一律以
-- 「未命名 ＋ 未開通」還原：讓管理員自己確認要開哪些，比擅自把群組重新打開安全。
INSERT OR IGNORE INTO `assistant_line_groups`
  (`id`, `channel_key`, `line_group_id`, `display_name`, `enabled`, `tool_mode`, `discovered_at`, `updated_at`)
SELECT
  lower(hex(randomblob(16))),
  `s`.`channel_key`,
  `s`.`line_group_id`,
  '',
  0,
  'inherit',
  `s`.`first_seen`,
  CURRENT_TIMESTAMP
FROM (
  SELECT `channel_key`, `line_group_id`, MIN(`created_at`) AS `first_seen`
  FROM `assistant_line_messages`
  GROUP BY `channel_key`, `line_group_id`

  UNION

  SELECT `r`.`channel_key`, `r`.`group_id`, MIN(`r`.`created_at`)
  FROM `assistant_runs` AS `r`
  WHERE `r`.`channel` = 'line'
    AND `r`.`group_id` IS NOT NULL
    AND `r`.`channel_key` IS NOT NULL
  GROUP BY `r`.`channel_key`, `r`.`group_id`
) AS `s`
WHERE NOT EXISTS (
  SELECT 1 FROM `assistant_line_groups` AS `g`
  WHERE `g`.`channel_key` = `s`.`channel_key`
    AND `g`.`line_group_id` = `s`.`line_group_id`
);
