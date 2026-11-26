-- 報公帳第一批只有送件端，類別管理要等會計系統那一批才有畫面；先放一組預設類別，員工送件才選得到。
-- 之後由會計在會計系統改名、排序或停用，這裡不再跟著改。
INSERT OR IGNORE INTO `accounting_expense_categories` (`id`, `name`, `sort_order`) VALUES
  ('expense-category-purchase', '通路進貨', 10),
  ('expense-category-supplies', '日常備品', 20),
  ('expense-category-transport', '交通運輸', 30),
  ('expense-category-meal', '餐費', 40),
  ('expense-category-shipping', '郵寄物流', 50),
  ('expense-category-other', '其他', 90);
