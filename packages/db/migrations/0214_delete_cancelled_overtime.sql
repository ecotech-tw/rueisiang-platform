-- 加班取消改為直接刪除申請（見 cancelHrOvertimeRequest）。先前留下的 cancelled 列不會再有人處理，
-- 一併清掉，申請紀錄才不會新舊兩種行為並存。沒有其他資料表以外鍵指向 hr_overtime_requests。
DELETE FROM `hr_overtime_requests` WHERE `status` = 'cancelled';
