-- CYBERBIZ 目錄從 SKU 主鍵搬到 items 的延伸表；舊表先保留成相容來源，供尚未搬完的 mapping 讀取。
PRAGMA foreign_keys = OFF;
--> statement-breakpoint
ALTER TABLE `cyberbiz_products` RENAME TO `cyberbiz_products_legacy`;
--> statement-breakpoint
CREATE TABLE `cyberbiz_products` (
  `item_id` text PRIMARY KEY NOT NULL,
  `cyberbiz_product_id` text NOT NULL,
  `cyberbiz_variant_id` text NOT NULL,
  `product_name` text DEFAULT '' NOT NULL,
  `variant_name` text DEFAULT '' NOT NULL,
  `published` integer DEFAULT 1 NOT NULL,
  `raw_json` text DEFAULT '{}' NOT NULL,
  `cyberbiz_updated_at` text,
  `sync_status` text DEFAULT 'synced' NOT NULL,
  `synced_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cyberbiz_products_external_id` ON `cyberbiz_products` (`cyberbiz_product_id`,`cyberbiz_variant_id`);
--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_products_item` ON `cyberbiz_products` (`item_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `cyberbiz_products` (`item_id`, `cyberbiz_product_id`, `cyberbiz_variant_id`, `product_name`, `variant_name`, `published`, `raw_json`, `synced_at`)
SELECT
  item.`id`,
  legacy.`product_id`,
  legacy.`variant_id`,
  legacy.`product_name`,
  legacy.`variant_name`,
  legacy.`published`,
  '{}',
  legacy.`synced_at`
FROM `cyberbiz_products_legacy` legacy
JOIN `items` item
  ON item.`source` = 'cyberbiz'
 AND lower(item.`sku`) = lower(legacy.`sku`);
--> statement-breakpoint
CREATE VIEW `cyberbiz_products_compat` AS
SELECT
  item.`sku` AS `sku`,
  product.`cyberbiz_product_id` AS `product_id`,
  product.`cyberbiz_variant_id` AS `variant_id`,
  product.`product_name` AS `product_name`,
  product.`variant_name` AS `variant_name`,
  product.`published` AS `published`,
  product.`synced_at` AS `synced_at`
FROM `cyberbiz_products` product
JOIN `items` item ON item.`id` = product.`item_id`;
--> statement-breakpoint
-- 測試與尚未搬完的舊讀取端仍以 SKU 形狀寫入；INSTEAD OF trigger 將其轉成 target，
-- 不另存一份商品資料，待 mapping 全部搬完即可連同 compat view 一起移除。
CREATE TRIGGER `trg_cyberbiz_products_compat_insert`
INSTEAD OF INSERT ON `cyberbiz_products_compat`
BEGIN
  INSERT INTO `cyberbiz_products_legacy` (`sku`, `product_id`, `variant_id`, `product_name`, `variant_name`, `published`, `synced_at`)
  VALUES (NEW.`sku`, NEW.`product_id`, NEW.`variant_id`, NEW.`product_name`, NEW.`variant_name`, NEW.`published`, COALESCE(NEW.`synced_at`, CURRENT_TIMESTAMP))
  ON CONFLICT (`sku`) DO UPDATE SET
    `product_id` = excluded.`product_id`,
    `variant_id` = excluded.`variant_id`,
    `product_name` = excluded.`product_name`,
    `variant_name` = excluded.`variant_name`,
    `published` = excluded.`published`,
    `synced_at` = excluded.`synced_at`;
  INSERT OR IGNORE INTO `items` (`id`, `source`, `kind`, `sku`, `name`, `active`)
  VALUES (
    'cb:' || NEW.`sku`,
    'cyberbiz',
    'sellable',
    NEW.`sku`,
    CASE WHEN NEW.`variant_name` <> '' THEN NEW.`product_name` || '（' || NEW.`variant_name` || '）' ELSE NEW.`product_name` END,
    1
  );
  INSERT INTO `cyberbiz_products` (`item_id`, `cyberbiz_product_id`, `cyberbiz_variant_id`, `product_name`, `variant_name`, `published`, `synced_at`)
  SELECT `id`, NEW.`product_id`, NEW.`variant_id`, NEW.`product_name`, NEW.`variant_name`, NEW.`published`, COALESCE(NEW.`synced_at`, CURRENT_TIMESTAMP)
  FROM `items` WHERE `source` = 'cyberbiz' AND lower(`sku`) = lower(NEW.`sku`)
  ON CONFLICT (`item_id`) DO UPDATE SET
    `cyberbiz_product_id` = excluded.`cyberbiz_product_id`,
    `cyberbiz_variant_id` = excluded.`cyberbiz_variant_id`,
    `product_name` = excluded.`product_name`,
    `variant_name` = excluded.`variant_name`,
    `published` = excluded.`published`,
    `synced_at` = excluded.`synced_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_cyberbiz_products_compat_update`
INSTEAD OF UPDATE ON `cyberbiz_products_compat`
BEGIN
  UPDATE `cyberbiz_products_legacy`
  SET `sku` = NEW.`sku`, `product_id` = NEW.`product_id`, `variant_id` = NEW.`variant_id`, `product_name` = NEW.`product_name`, `variant_name` = NEW.`variant_name`, `published` = NEW.`published`, `synced_at` = COALESCE(NEW.`synced_at`, CURRENT_TIMESTAMP)
  WHERE `sku` = OLD.`sku`;
  UPDATE `cyberbiz_products`
  SET `cyberbiz_product_id` = NEW.`product_id`, `cyberbiz_variant_id` = NEW.`variant_id`, `product_name` = NEW.`product_name`, `variant_name` = NEW.`variant_name`, `published` = NEW.`published`, `synced_at` = COALESCE(NEW.`synced_at`, CURRENT_TIMESTAMP)
  WHERE `item_id` = (SELECT `id` FROM `items` WHERE `source` = 'cyberbiz' AND lower(`sku`) = lower(OLD.`sku`) LIMIT 1);
END;
--> statement-breakpoint
PRAGMA foreign_keys = ON;
