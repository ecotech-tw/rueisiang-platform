-- 資料搬移：把「目前已啟用的工具」寫成既有 channel 的白名單。
--
-- 沒有這一段的話，0024 部署完的那一刻小香會突然一個工具都不能用——新的授權來源是
-- assistant_channel_tools，而它是空的。行為要無縫接上：換權限模型不該讓線上的 bot
-- 安靜地變笨。
--
-- 只補 status = 'enabled' 的。'development' 是「只能在 Sandbox 驗證」，本來就不該
-- 出現在 LINE，補進來等於偷偷放行。
--
-- 之後新開的 channel 一律從空白開始（沒有列 = 不給）；這支只服務「換模型之前就存在」
-- 的那一個 channel。用 INSERT OR IGNORE ＋ 唯一索引保護，重跑不會插出重複。
INSERT OR IGNORE INTO `assistant_channel_tools` (`id`, `channel_key`, `tool_key`, `created_by`)
SELECT
  lower(hex(randomblob(16))),
  `c`.`channel_key`,
  `t`.`key`,
  'migration:0025'
FROM `assistant_line_channels` AS `c`
CROSS JOIN `assistant_tool_configs` AS `t`
WHERE `t`.`status` = 'enabled';
