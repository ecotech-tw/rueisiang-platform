-- name 從此是「我們自己叫它什麼」，可以隨時改；external_name 是拿去跟外部系統
-- 對帳的鍵。CYBERBIZ 的 runner 一直是用 name 去後台找店，所以既有的值就是
-- external_name 該有的內容，先原封不動搬過去，改名才不會把 runner 弄丟。
--
-- 其他來源（shopee、manual）沒有以名字對帳的外部系統，留空。
UPDATE `scopes` SET `external_name` = `name` WHERE `source_type` = 'cyberbiz';
