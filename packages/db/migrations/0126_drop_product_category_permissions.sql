-- tools:product-category:read / :write 是 items:category:read / :write 的第二份
-- 實作：兩者寫同一張 item_categories，只是入口不同。/tools/product-categories 的
-- 選單入口在 schema 改造那一輪已經拿掉，程式碼這一輪一起移除。
--
-- 授權表的 permission 是 ON DELETE RESTRICT 指向 permissions 鏡像，所以這支
-- migration 自己的順序不能反：先清授權，才刪得掉鏡像那兩列。
--
-- 而且鏡像一定要在這裡刪掉。syncSystemRoles 對 permissions 只有 insert 與
-- onConflictDoUpdate，全 repo 沒有任何地方會 DELETE FROM permissions——它不會
-- 幫你修剪。從 permissions.ts 拿掉一個權限而不寫 migration，鏡像就會安靜地
-- 留一列廢資料，而授權表還指得到它。
--
-- 不補發 items:category:*：正式庫查過，個人授權沒有任何人拿這兩個鍵，而拿到
-- 它們的 admin 與 manager 兩個角色本來就有 items:category:read/write。
DELETE FROM `role_permission_grants`
WHERE `permission` IN ('tools:product-category:read', 'tools:product-category:write');--> statement-breakpoint

DELETE FROM `user_permission_grants`
WHERE `permission` IN ('tools:product-category:read', 'tools:product-category:write');--> statement-breakpoint

DELETE FROM `permissions`
WHERE `permission` IN ('tools:product-category:read', 'tools:product-category:write');
