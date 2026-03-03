ALTER TABLE `agents` ADD `location_text` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `location_lat` real;--> statement-breakpoint
ALTER TABLE `agents` ADD `location_lng` real;--> statement-breakpoint
ALTER TABLE `agents` ADD `location_resolution` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `location_label` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `location_anywhere` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `agents` ADD `distance_radius_km` real;
