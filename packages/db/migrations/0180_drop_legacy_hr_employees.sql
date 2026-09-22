-- 0179 已完成 parent swap，且所有 foreign key／trigger 都改指正式 hr_employments；
-- 此時 legacy employee record 沒有任何引用，最後才安全移除重複的人事主檔。
DROP TABLE `hr_employees`;
