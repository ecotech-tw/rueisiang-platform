CREATE TABLE `store_locator_publication` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`published_revision` integer DEFAULT 0 NOT NULL,
	`published_at` text,
	`error` text,
	CONSTRAINT "ck_store_locator_publication_singleton" CHECK("store_locator_publication"."id" = 'public'),
	CONSTRAINT "ck_store_locator_publication_revision" CHECK("store_locator_publication"."revision" >= "store_locator_publication"."published_revision" AND "store_locator_publication"."published_revision" >= 0)
);
