/* legacy zone_images 有一筆指向不存在 media_objects 的懸空資料；不能搬成 target FK。 */
DELETE FROM `zone_images`
WHERE NOT EXISTS (
  SELECT 1 FROM `media_objects` media WHERE media.`object_key` = `zone_images`.`object_key`
);
