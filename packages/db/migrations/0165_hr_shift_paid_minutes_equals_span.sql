-- 班別的計薪工時改成「就是班別的長度」、休息固定 0，唯一來源是 apps/api/src/routes/hr.ts 的
-- defaultShiftMinutes；班別管理不再讓人手填這兩個值。
--
-- 舊資料一定要一起回填，否則同樣時段的班會有兩種算法：這次之後編輯過的照時段給薪，沒被碰過的
-- 還留著舊值，而薪資的時數正是從 standard_minutes 來的
-- （packages/db/src/hr-payroll-calculation.ts 的 scheduledHours）。
--
-- 舊的預設值寫死 Math.min(480, duration)，所以超過 8 小時的班會被存成 480；這支一併修正。
--
-- 只改 hr_shift_versions（班別本身），不動 hr_schedule_entries 與 hr_schedule_worker_entries：
-- 那兩張表存的是排班當下的快照，也是已經發過薪水的依據，往回改等於改動歷史薪資。
-- 之後新排的班會照新規則重新快照。
--
-- 跨午夜的舊班別（end_day_offset = 1）排除在外：它們的長度要跨日才算得出來，而且系統已經
-- 不讓人再編輯，維持原值比用一條算式猜它安全。
UPDATE hr_shift_versions
SET standard_minutes = (end_second - start_second) / 60,
    break_minutes = 0
WHERE end_day_offset = 0;
