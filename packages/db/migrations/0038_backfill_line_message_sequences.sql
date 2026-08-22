-- 資料回填：把既有 LINE 訊息依每個 channel／對話的建立時間補上順序，
-- 讓新部署後的 Queue gate 不會把歷史資料全部視為同一個序號。
UPDATE `assistant_line_messages` AS `current_message`
SET `sequence` = (
  SELECT COUNT(*)
  FROM `assistant_line_messages` AS `previous_message`
  WHERE `previous_message`.`channel_key` = `current_message`.`channel_key`
    AND `previous_message`.`line_group_id` = `current_message`.`line_group_id`
    AND (
      `previous_message`.`created_at` < `current_message`.`created_at`
      OR (
        `previous_message`.`created_at` = `current_message`.`created_at`
        AND `previous_message`.`id` <= `current_message`.`id`
      )
    )
);
--> statement-breakpoint
UPDATE `assistant_line_groups` AS `groups`
SET `next_message_sequence` = COALESCE((
  SELECT MAX(`messages`.`sequence`)
  FROM `assistant_line_messages` AS `messages`
  WHERE `messages`.`channel_key` = `groups`.`channel_key`
    AND `messages`.`line_group_id` = `groups`.`line_group_id`
), 0);
