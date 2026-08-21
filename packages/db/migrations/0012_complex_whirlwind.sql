CREATE TABLE `assistant_configs` (
	`assistant_key` text PRIMARY KEY NOT NULL,
	`active_model` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
