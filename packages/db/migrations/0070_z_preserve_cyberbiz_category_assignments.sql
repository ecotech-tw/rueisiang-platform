-- The generated 0071 migration rebuilds cyberbiz_product_categories because its
-- category FK changes. D1 runs migrations in a transaction, so existing child rows
-- cannot be copied into the new table until the new report dictionary has rows.
-- Keep the assignments outside the table while Drizzle performs that rebuild.
CREATE TABLE `_legacy_cyberbiz_product_categories` (
  `sku` text NOT NULL,
  `category_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`sku`, `category_id`)
);
--> statement-breakpoint
INSERT INTO `_legacy_cyberbiz_product_categories` (`sku`, `category_id`, `created_at`, `updated_at`)
SELECT `sku`, `category_id`, `created_at`, `updated_at`
FROM `cyberbiz_product_categories`;
--> statement-breakpoint
DELETE FROM `cyberbiz_product_categories`;
