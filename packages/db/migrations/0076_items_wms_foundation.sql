CREATE TABLE `item_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`parent_id` text,
	`parent_depth` integer,
	`name` text NOT NULL,
	`color` text DEFAULT 'rose' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_item_categories_root_name` ON `item_categories` (`name`) WHERE `parent_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_item_categories_child_name` ON `item_categories` (`parent_id`,`name`) WHERE `parent_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_item_categories_parent` ON `item_categories` (`parent_id`,`sort_order`);
--> statement-breakpoint
INSERT OR IGNORE INTO `item_categories` (`id`, `depth`, `parent_id`, `name`, `color`, `sort_order`, `active`, `created_at`, `updated_at`)
SELECT `id`, 0, NULL, `name`, `color`, 0, 1, `created_at`, `updated_at` FROM `report_product_categories`;
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`kind` text DEFAULT 'sellable' NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`category_id` text,
	`list_price` integer,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `item_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_items_source_sku` ON `items` (`source`,`sku`);
--> statement-breakpoint
CREATE INDEX `idx_items_category` ON `items` (`category_id`,`active`);
--> statement-breakpoint
CREATE INDEX `idx_items_name` ON `items` (`name`);
--> statement-breakpoint
CREATE TABLE `wms_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'rose' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `wms_categories` (`id`, `name`, `color`, `active`, `created_at`, `updated_at`)
SELECT `id`, `name`, `color`, 1, `created_at`, `updated_at` FROM `warehouse_categories`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wms_categories_name` ON `wms_categories` (`name`);
--> statement-breakpoint
CREATE TRIGGER `trg_warehouse_categories_to_wms_categories_insert` AFTER INSERT ON `warehouse_categories`
BEGIN
  INSERT OR IGNORE INTO `wms_categories` (`id`, `name`, `color`, `active`, `created_at`, `updated_at`)
  VALUES (NEW.`id`, NEW.`name`, NEW.`color`, 1, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_warehouse_categories_to_wms_categories_update` AFTER UPDATE ON `warehouse_categories`
BEGIN
  UPDATE `wms_categories`
  SET `name` = NEW.`name`, `color` = NEW.`color`, `updated_at` = NEW.`updated_at`
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_warehouse_categories_to_wms_categories_delete` AFTER DELETE ON `warehouse_categories`
BEGIN
  DELETE FROM `wms_categories` WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TABLE `wms_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'mint' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `wms_zones` (`id`, `code`, `name`, `color`, `notes`, `active`, `created_at`, `updated_at`)
SELECT `id`, `code`, `name`, `color`, `notes`, 1, `created_at`, `updated_at` FROM `zones`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wms_zones_code` ON `wms_zones` (`code`);
--> statement-breakpoint
CREATE TRIGGER `trg_zones_to_wms_zones_insert` AFTER INSERT ON `zones`
BEGIN
  INSERT OR IGNORE INTO `wms_zones` (`id`, `code`, `name`, `color`, `notes`, `active`, `created_at`, `updated_at`)
  VALUES (NEW.`id`, NEW.`code`, NEW.`name`, NEW.`color`, NEW.`notes`, 1, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_zones_to_wms_zones_update` AFTER UPDATE ON `zones`
BEGIN
  UPDATE `wms_zones`
  SET `code` = NEW.`code`, `name` = NEW.`name`, `color` = NEW.`color`, `notes` = NEW.`notes`, `updated_at` = NEW.`updated_at`
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_zones_to_wms_zones_delete` AFTER DELETE ON `zones`
BEGIN
  DELETE FROM `wms_zones` WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TABLE `wms_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`canvas_width` integer DEFAULT 1600 NOT NULL,
	`canvas_height` integer DEFAULT 900 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wms_layouts_name` ON `wms_layouts` (`name`);
--> statement-breakpoint
CREATE TABLE `wms_shelves` (
	`id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`zone_id`) REFERENCES `wms_zones`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wms_shelves_zone_code` ON `wms_shelves` (`zone_id`,`code`);
--> statement-breakpoint
CREATE INDEX `idx_wms_shelves_zone` ON `wms_shelves` (`zone_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `wms_layout_elements` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`element_type` text NOT NULL,
	`zone_id` text,
	`label` text DEFAULT '' NOT NULL,
	`color` text DEFAULT 'rose' NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`z_index` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `wms_layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`zone_id`) REFERENCES `wms_zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_wms_layout_elements_layout` ON `wms_layout_elements` (`layout_id`,`z_index`);
--> statement-breakpoint
CREATE INDEX `idx_wms_layout_elements_zone` ON `wms_layout_elements` (`zone_id`);
--> statement-breakpoint
CREATE TABLE `wms_zone_images` (
	`zone_id` text NOT NULL,
	`object_key` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`zone_id`, `object_key`),
	FOREIGN KEY (`zone_id`) REFERENCES `wms_zones`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_key`) REFERENCES `media_objects`(`object_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_wms_zone_images_zone` ON `wms_zone_images` (`zone_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `wms_items` (
	`item_id` text PRIMARY KEY NOT NULL,
	`wms_category_id` text,
	`shelf_id` text,
	`quantity` integer DEFAULT 0 NOT NULL,
	`unit` text DEFAULT '件' NOT NULL,
	`min_stock` integer DEFAULT 5 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wms_category_id`) REFERENCES `wms_categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`shelf_id`) REFERENCES `wms_shelves`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_wms_items_shelf` ON `wms_items` (`shelf_id`);
--> statement-breakpoint
CREATE INDEX `idx_wms_items_category` ON `wms_items` (`wms_category_id`);
--> statement-breakpoint
CREATE INDEX `idx_wms_items_low_stock` ON `wms_items` (`item_id`) WHERE `quantity` < `min_stock`;
--> statement-breakpoint
CREATE TABLE `item_components` (
	`parent_item_id` text NOT NULL,
	`component_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`parent_item_id`, `component_item_id`),
	FOREIGN KEY (`parent_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_item_components_component` ON `item_components` (`component_item_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `items` (`id`, `source`, `kind`, `sku`, `name`, `category_id`, `active`, `created_at`, `updated_at`)
SELECT
  COALESCE(cpl.inventory_item_id, 'cb:' || cp.sku),
  'cyberbiz',
  'sellable',
  cp.sku,
  CASE WHEN cp.variant_name <> '' AND cp.variant_name IS NOT NULL THEN cp.product_name || '（' || cp.variant_name || '）' ELSE cp.product_name END,
  cpc.category_id,
  1,
  cp.synced_at,
  cp.synced_at
FROM `cyberbiz_products` cp
LEFT JOIN `cyberbiz_product_links` cpl ON cpl.sku = cp.sku
LEFT JOIN `cyberbiz_product_categories` cpc ON cpc.sku = cp.sku;
--> statement-breakpoint
INSERT OR IGNORE INTO `items` (`id`, `source`, `kind`, `sku`, `name`, `category_id`, `active`, `created_at`, `updated_at`)
SELECT
  ii.id,
  'custom',
  'supply',
  COALESCE(NULLIF(ii.sku, ''), 'WMS-' || substr(ii.id, 1, 8)),
  ii.name,
  NULL,
  1,
  ii.created_at,
  ii.updated_at
FROM `inventory_items` ii;
--> statement-breakpoint
INSERT OR IGNORE INTO `wms_items` (`item_id`, `wms_category_id`, `shelf_id`, `quantity`, `unit`, `min_stock`, `notes`, `created_at`, `updated_at`)
SELECT
  ii.id,
  wc.id,
  NULL,
  ii.quantity,
  ii.unit,
  ii.min_stock,
  ii.notes,
  ii.created_at,
  ii.updated_at
FROM `inventory_items` ii
LEFT JOIN `warehouse_categories` wc ON wc.name = ii.category;
