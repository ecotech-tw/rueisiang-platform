CREATE TABLE `store_locator_profiles` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`store_locator_category` text DEFAULT '' NOT NULL,
	`store_locator_label` text DEFAULT '' NOT NULL,
	`store_locator_short_name` text DEFAULT '' NOT NULL,
	`store_locator_county` text DEFAULT '' NOT NULL,
	`store_locator_address` text DEFAULT '' NOT NULL,
	`store_locator_floor_note` text DEFAULT '' NOT NULL,
	`store_locator_hours` text DEFAULT '' NOT NULL,
	`store_locator_phone` text DEFAULT '' NOT NULL,
	`store_locator_highlight` text DEFAULT '' NOT NULL,
	`store_locator_image_id` text,
	`store_locator_map_url` text DEFAULT '' NOT NULL,
	`store_locator_pin_x` real,
	`store_locator_pin_y` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict
);
