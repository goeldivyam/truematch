CREATE TABLE `agents` (
	`pubkey` text PRIMARY KEY NOT NULL,
	`card_url` text NOT NULL,
	`inbox_url` text NOT NULL,
	`contact_channel_type` text NOT NULL,
	`contact_channel_value` text NOT NULL,
	`last_seen` integer NOT NULL,
	`registered_at` integer NOT NULL,
	`protocol_version` text DEFAULT '1.0' NOT NULL
);
