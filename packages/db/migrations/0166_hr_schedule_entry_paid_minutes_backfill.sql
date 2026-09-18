-- 0165 只回填了班別本身；已發布的排班紀錄裡還留著舊值，而薪資的時數其實是從這裡讀的
-- （packages/db/src/hr-payroll-calculation.ts 的 scheduledHours 吃的是 entry 的 standard_minutes，
-- 不是班別的）。不一起補的話，超過 8 小時的班會繼續照舊的 Math.min(480, duration) 少算工時。
--
-- 用每一筆自己的 starts_at／ends_at 算，不去 join 班別：entry 是排班當下的快照，班別後來可能
-- 已經被改過時間，拿現在的班別回推會把當時排的那一天算成另一個長度。ends_at 跨午夜時本來就
-- 落在隔天，所以這條算式對夜班也成立。
--
-- 已經結算過的薪資單不受影響：hr_payslips 存的是金額快照，hr_payroll_runs 也另外存了
-- source_snapshot_json，都不會因為這裡改動而重算。受影響的只有之後重跑的試算。
--
-- BETWEEN 1 AND 1440 同時擋掉兩件事：算不出合理長度的爛資料，以及 standard_minutes 的
-- CHECK 上限；超出範圍的那幾筆維持原值，寧可保留原樣也不要寫進一個會讓整支 migration 失敗的值。
UPDATE hr_schedule_entries
SET standard_minutes = CAST(round((julianday(ends_at) - julianday(starts_at)) * 1440) AS INTEGER),
    break_minutes = 0
WHERE CAST(round((julianday(ends_at) - julianday(starts_at)) * 1440) AS INTEGER) BETWEEN 1 AND 1440;

UPDATE hr_schedule_worker_entries
SET standard_minutes = CAST(round((julianday(ends_at) - julianday(starts_at)) * 1440) AS INTEGER),
    break_minutes = 0
WHERE CAST(round((julianday(ends_at) - julianday(starts_at)) * 1440) AS INTEGER) BETWEEN 1 AND 1440;
