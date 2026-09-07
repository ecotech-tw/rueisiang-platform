CREATE TABLE `cyberbiz_sync_locks` (
	`item_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`lease_until` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_sync_locks_lease` ON `cyberbiz_sync_locks` (`lease_until`);