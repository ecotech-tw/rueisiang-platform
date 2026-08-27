-- 商品銷售的查詢粒度改成月份；同一據點、月份、SKU 的數量與金額相加。
-- 商品名稱與分類在同一據點的同一 SKU 應保持一致，空值不會蓋掉有效文字。
INSERT INTO `report_sales_monthly` (
	`scope_id`,
	`report_month`,
	`sku`,
	`product_name`,
	`category`,
	`gross_quantity`,
	`return_quantity`,
	`net_quantity`,
	`sales_amount`,
	`updated_at`
)
SELECT
	`scope_id`,
	substr(`business_date`, 1, 7),
	`sku`,
	COALESCE(MAX(NULLIF(`product_name`, '')), ''),
	COALESCE(MAX(NULLIF(`category`, '')), '未分類'),
	SUM(`gross_quantity`),
	SUM(`return_quantity`),
	SUM(`net_quantity`),
	SUM(`sales_amount`),
	MAX(`updated_at`)
FROM `report_sales_daily`
GROUP BY `scope_id`, substr(`business_date`, 1, 7), `sku`;
