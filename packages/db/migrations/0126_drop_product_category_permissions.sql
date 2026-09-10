-- tools:product-category:read / :write 是 items:category:read / :write 的第二份
-- 實作：兩者寫同一張 item_categories，只是入口不同。/tools/product-categories 的
-- 選單入口在 schema 改造那一輪已經拿掉，程式碼這一輪一起移除。
--
-- 授權表的 permission 是 ON DELETE RESTRICT 指向 permissions 鏡像，所以順序不能
-- 反：先清授權，再清鏡像。反過來的話「重新同步」會在刪鏡像那一步當場報錯，
-- 而且是部署之後才會遇到。
DELETE FROM `role_permission_grants`
WHERE `permission` IN ('tools:product-category:read', 'tools:product-category:write');--> statement-breakpoint

DELETE FROM `user_permission_grants`
WHERE `permission` IN ('tools:product-category:read', 'tools:product-category:write');--> statement-breakpoint

DELETE FROM `permissions`
WHERE `permission` IN ('tools:product-category:read', 'tools:product-category:write');
