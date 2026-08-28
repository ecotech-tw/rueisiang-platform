-- Custom SQL migration file, put your code below! --
-- 既有 mapping 沒有來源通路，先標成 legacy；解析時會把它當作相容 fallback，避免既有報表失效。
ALTER TABLE `product_sku_mappings` ADD `channel` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
DROP INDEX `product_sku_mappings_external_sku_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_product_sku_mappings_channel_external_sku`
  ON `product_sku_mappings` (`channel`, `external_sku`);
