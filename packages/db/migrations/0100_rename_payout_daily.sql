/* 拆掉大改版留下的鷹架。

   0080 開這張表時，舊的 report_payout_daily 還在、裡面是歷史出金，直接重建會把它弄丟，
   所以先用一個帶 _target 的暫時名字讓兩張並存（那支 migration 的第一行寫的就是「先」）。
   0088 把舊表刪掉之後名字就空出來了，只是沒有人改回來。

   設計文件 docs/platform-schema-target.sql 寫的名字一直都是 report_payout_daily。

   用 RENAME 而不是重建：沒有任何一張表用外鍵指向它，索引會跟著表走，也不會踩到
   D1 上「重建表連坐刪資料」那個坑。 */
ALTER TABLE `report_payout_daily_target` RENAME TO `report_payout_daily`;
