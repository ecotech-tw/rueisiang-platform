ALTER TABLE `product_bundle_components` ADD `cyberbiz_sku` text REFERENCES cyberbiz_products(sku);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_product_bundle_components_cyberbiz` ON `product_bundle_components` (`mapping_id`,`cyberbiz_sku`);--> statement-breakpoint
CREATE INDEX `idx_product_bundle_components_cyberbiz_sku` ON `product_bundle_components` (`cyberbiz_sku`);