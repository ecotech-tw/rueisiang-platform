/* 將 legacy WMS 的層架、地圖與裝飾搬到 target；位置資料完成後才可移除 legacy WMS 表。 */
INSERT OR IGNORE INTO `wms_layouts` (`id`, `name`, `canvas_width`, `canvas_height`, `active`, `created_at`, `updated_at`)
SELECT
  'layout:' || ws.`id`,
  '主倉庫',
  ws.`canvas_width`,
  ws.`canvas_height`,
  1,
  ws.`updated_at`,
  ws.`updated_at`
FROM `warehouse_settings` ws;
--> statement-breakpoint
INSERT OR IGNORE INTO `wms_layouts` (`id`, `name`, `canvas_width`, `canvas_height`, `active`)
SELECT 'layout:main', '主倉庫', 1600, 900, 1
WHERE NOT EXISTS (SELECT 1 FROM `wms_layouts`);
--> statement-breakpoint
INSERT OR IGNORE INTO `wms_shelves` (`id`, `zone_id`, `code`, `name`, `sort_order`, `active`, `created_at`, `updated_at`)
SELECT
  'shelf:' || z.`id` || ':' || json_extract(level.value, '$.id'),
  z.`id`,
  json_extract(level.value, '$.id'),
  json_extract(level.value, '$.name'),
  CAST(level.key AS INTEGER),
  1,
  z.`created_at`,
  z.`updated_at`
FROM `zones` z, json_each(z.`shelf_levels`) level
WHERE json_extract(level.value, '$.id') IS NOT NULL
  AND json_extract(level.value, '$.id') <> '';
--> statement-breakpoint
INSERT OR IGNORE INTO `wms_items` (`item_id`, `shelf_id`)
SELECT ii.`id`, 'shelf:' || ii.`zone_id` || ':' || ii.`shelf_level`
FROM `inventory_items` ii
JOIN `wms_shelves` shelf ON shelf.`id` = 'shelf:' || ii.`zone_id` || ':' || ii.`shelf_level`
WHERE ii.`zone_id` IS NOT NULL AND ii.`shelf_level` IS NOT NULL
ON CONFLICT (`item_id`) DO UPDATE SET `shelf_id` = excluded.`shelf_id`, `updated_at` = CURRENT_TIMESTAMP;
--> statement-breakpoint
INSERT OR IGNORE INTO `wms_layout_elements` (`id`, `layout_id`, `element_type`, `zone_id`, `label`, `color`, `x`, `y`, `width`, `height`, `z_index`, `created_at`, `updated_at`)
SELECT
  'wms-zone:' || z.`id`,
  COALESCE((SELECT id FROM `wms_layouts` ORDER BY id LIMIT 1), 'layout:main'),
  'zone',
  z.`id`,
  z.`name`,
  z.`color`,
  z.`x`, z.`y`, z.`width`, z.`height`,
  0,
  z.`created_at`, z.`updated_at`
FROM `zones` z;
--> statement-breakpoint
INSERT OR IGNORE INTO `wms_layout_elements` (`id`, `layout_id`, `element_type`, `label`, `color`, `x`, `y`, `width`, `height`, `z_index`, `created_at`, `updated_at`)
SELECT
  'wms-decoration:' || element.`id`,
  COALESCE((SELECT id FROM `wms_layouts` ORDER BY id LIMIT 1), 'layout:main'),
  'decoration',
  element.`label`,
  element.`color`,
  element.`x`, element.`y`, element.`width`, element.`height`,
  1,
  element.`created_at`, element.`updated_at`
FROM `layout_elements` element;
--> statement-breakpoint
INSERT OR IGNORE INTO `wms_zone_images` (`zone_id`, `object_key`, `sort_order`, `created_at`)
SELECT image.`zone_id`, image.`object_key`, 0, image.`created_at`
FROM `zone_images` image
JOIN `media_objects` media ON media.`object_key` = image.`object_key`;
