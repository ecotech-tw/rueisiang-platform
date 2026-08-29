-- 自訂 SKU 從「整筆 mapping 的模式」下放到「每一列用料」。
--
-- 舊模型在 product_sku_mappings 上放 inventory_item_id 與 system_sku 當作兩種模式，
-- 但自訂模式下使用者填的用料整包被 resolveProductSkus 忽略。改成用料自己決定來源之後
-- 那個矛盾消失，父表也不必再記「這筆對應是什麼商品」。
--
-- 順序照 0058：先把子表搬到新的父表上，最後才 DROP 舊表——直接 DROP 父表會被
-- ON DELETE CASCADE 連坐刪掉所有用料（0023 踩過）。
CREATE TABLE `custom_report_products` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT '未分類' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_report_products_sku_unique` ON `custom_report_products` (`sku`);
--> statement-breakpoint
-- 既有的自訂 mapping（沒有 WMS 主商品）各自轉成一筆自訂商品主檔。
-- 同一個 system_sku 可能被多個通路指到，所以取 MIN(id) 去重成一列。
INSERT INTO `custom_report_products` (`id`, `sku`, `name`, `category`)
SELECT
	'custom-' || UPPER(`system_sku`),
	UPPER(`system_sku`),
	MIN(`external_name`),
	'未分類'
FROM `product_sku_mappings`
WHERE `inventory_item_id` IS NULL
	AND `system_sku` IS NOT NULL
	AND TRIM(`system_sku`) <> ''
GROUP BY UPPER(`system_sku`);
--> statement-breakpoint
CREATE TABLE `product_sku_mappings_new` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text DEFAULT 'legacy' NOT NULL,
	`external_name` text DEFAULT '' NOT NULL,
	`external_sku` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `product_sku_mappings_new` (
	`id`, `channel`, `external_name`, `external_sku`, `created_at`, `updated_at`
)
SELECT `id`, `channel`, `external_name`, `external_sku`, `created_at`, `updated_at`
FROM `product_sku_mappings`;
--> statement-breakpoint
CREATE TABLE `product_bundle_components_new` (
	`id` text PRIMARY KEY NOT NULL,
	`mapping_id` text NOT NULL,
	`inventory_item_id` text,
	`custom_product_id` text,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`mapping_id`) REFERENCES `product_sku_mappings_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`custom_product_id`) REFERENCES `custom_report_products`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- 有 WMS 主商品的 mapping：用料原封不動搬過去。
--
-- id 決定用料順序，而匯入端把整筆銷售額記在第一列用料上。所以舊的「主商品」
-- （mapping.inventory_item_id）一定要拿到 :000，其餘依商品 id 接在後面——用
-- mapping_id||inventory_item_id 當 id 的話等於照 UUID 排序，重匯一個已經匯過的月份
-- 會靜默地把整筆組合的營收換一個 SKU 收。
INSERT INTO `product_bundle_components_new` (`id`, `mapping_id`, `inventory_item_id`, `custom_product_id`, `quantity`)
SELECT
	`component`.`mapping_id` || ':' || SUBSTR('000' || (
		CASE WHEN `component`.`inventory_item_id` = `mapping`.`inventory_item_id` THEN 0 ELSE (
			SELECT COUNT(*) + 1
			FROM `product_bundle_components` AS `earlier`
			WHERE `earlier`.`mapping_id` = `component`.`mapping_id`
				AND `earlier`.`inventory_item_id` <> `mapping`.`inventory_item_id`
				AND `earlier`.`inventory_item_id` < `component`.`inventory_item_id`
		) END
	), -3),
	`component`.`mapping_id`,
	`component`.`inventory_item_id`,
	NULL,
	`component`.`quantity`
FROM `product_bundle_components` AS `component`
JOIN `product_sku_mappings` AS `mapping` ON `mapping`.`id` = `component`.`mapping_id`
WHERE `mapping`.`inventory_item_id` IS NOT NULL;
--> statement-breakpoint
-- 自訂 mapping：舊的 WMS 用料本來就沒有被報表用到（只寫 system_sku 一列），
-- 所以照現在的實際輸出轉成單一自訂用料，匯入結果不變。要展開成材料消耗再自己加。
INSERT INTO `product_bundle_components_new` (`id`, `mapping_id`, `inventory_item_id`, `custom_product_id`, `quantity`)
SELECT
	`mapping`.`id` || ':000',
	`mapping`.`id`,
	NULL,
	`custom`.`id`,
	1
FROM `product_sku_mappings` AS `mapping`
JOIN `custom_report_products` AS `custom` ON `custom`.`sku` = UPPER(`mapping`.`system_sku`)
WHERE `mapping`.`inventory_item_id` IS NULL;
--> statement-breakpoint
DROP TABLE `product_bundle_components`;
--> statement-breakpoint
DROP TABLE `product_sku_mappings`;
--> statement-breakpoint
ALTER TABLE `product_sku_mappings_new` RENAME TO `product_sku_mappings`;
--> statement-breakpoint
ALTER TABLE `product_bundle_components_new` RENAME TO `product_bundle_components`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_product_sku_mappings_channel_external_sku`
	ON `product_sku_mappings` (`channel`, `external_sku`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_product_bundle_components_item`
	ON `product_bundle_components` (`mapping_id`, `inventory_item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_product_bundle_components_custom`
	ON `product_bundle_components` (`mapping_id`, `custom_product_id`);
--> statement-breakpoint
CREATE INDEX `idx_product_bundle_components_inventory_item`
	ON `product_bundle_components` (`inventory_item_id`);
--> statement-breakpoint
CREATE INDEX `idx_product_bundle_components_custom_product`
	ON `product_bundle_components` (`custom_product_id`);
