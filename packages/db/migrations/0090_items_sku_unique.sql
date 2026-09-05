DROP INDEX `idx_items_source_sku`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_sku` ON `items` (`sku`);