-- 正式庫的 item_categories 是一張裸表：0076 只建了欄位，複合外鍵、三條 CHECK
-- 與 UNIQUE(id, depth) 一個都沒有。schema/items.ts 三樣都宣告了，所以「兩層分類」
-- 這件事現在只存在於程式的想像裡——正式環境擋不住第三層，也擋不住自環。
--
-- 為什麼手寫而不是 pnpm generate：drizzle 產的重建 SQL 會直接 DROP TABLE，而
-- items.category_id 是 ON DELETE SET NULL 指著這張表。D1 的 migration 整支包在
-- 一個 transaction 裡，PRAGMA foreign_keys 在 transaction 裡是 no-op，所以那個
-- DROP 會把所有品項的分類靜靜清成 NULL。0023 就是這樣把 line group 刪光的。
--
-- 這裡的順序是為了三件事：
--   1. 先把分類本身與 items 的分類對應存到暫存表，DROP 之後才寫得回來。
--   2. 新表建好之後先建索引再塞資料——複合外鍵要靠 idx_item_categories_id_depth
--      當父鍵，索引不在的話 INSERT 會 foreign key mismatch。
--   3. 塞資料時 ORDER BY depth，父分類一定先進去。
--
-- 新表的 DDL 逐字取自 drizzle 依 schema/items.ts 產生的版本，snapshot 才對得上。

CREATE TABLE `_item_categories_backup` AS SELECT * FROM `item_categories`;--> statement-breakpoint
CREATE TABLE `_item_category_assignments` AS
  SELECT `id` AS `item_id`, `category_id` FROM `items` WHERE `category_id` IS NOT NULL;--> statement-breakpoint

DROP TABLE `item_categories`;--> statement-breakpoint

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
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`parent_id`,`parent_depth`) REFERENCES `item_categories`(`id`,`depth`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_item_categories_depth" CHECK("item_categories"."depth" IN (0, 1)),
	CONSTRAINT "ck_item_categories_parent_by_depth" CHECK(("item_categories"."depth" = 0) = ("item_categories"."parent_id" IS NULL)),
	CONSTRAINT "ck_item_categories_parent_depth" CHECK("item_categories"."parent_id" IS NULL OR "item_categories"."parent_depth" = 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX `idx_item_categories_id_depth` ON `item_categories` (`id`,`depth`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_item_categories_root_name` ON `item_categories` (`name`) WHERE "item_categories"."parent_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_item_categories_child_name` ON `item_categories` (`parent_id`,`name`) WHERE "item_categories"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_item_categories_parent` ON `item_categories` (`parent_id`,`sort_order`);--> statement-breakpoint

INSERT INTO `item_categories`
  (`id`, `depth`, `parent_id`, `parent_depth`, `name`, `color`, `sort_order`, `active`, `created_at`, `updated_at`)
  SELECT `id`, `depth`, `parent_id`, `parent_depth`, `name`, `color`, `sort_order`, `active`, `created_at`, `updated_at`
  FROM `_item_categories_backup` ORDER BY `depth`;--> statement-breakpoint

-- DROP TABLE 時 items.category_id 已經被 SET NULL 清掉，這裡照對應表寫回去。
UPDATE `items` SET `category_id` = (
  SELECT `category_id` FROM `_item_category_assignments` WHERE `item_id` = `items`.`id`
) WHERE `id` IN (SELECT `item_id` FROM `_item_category_assignments`);--> statement-breakpoint

DROP TABLE `_item_categories_backup`;--> statement-breakpoint
DROP TABLE `_item_category_assignments`;
