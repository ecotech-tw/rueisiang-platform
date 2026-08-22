-- 資料回填：把「同步機制上線前就有名字」的群組標記為人工命名。
--
-- 0030 新增的 display_name_manual 預設是 false。不回填的話，那些管理員自己打過名字的
-- 群組會在下一次同步時被 LINE 的原名蓋掉——把「專案討論」改成「倉庫群」這種決定就沒了。
--
-- 判斷條件：有名字、但從來沒跟 LINE 同步過（profile_synced_at IS NULL）。名字不是同步
-- 來的，就只可能是人打的。
--
-- 用 WHERE 保護，重跑不會多做事。
UPDATE `assistant_line_groups`
SET `display_name_manual` = 1
WHERE `display_name` != ''
  AND `profile_synced_at` IS NULL
  AND `display_name_manual` = 0;
