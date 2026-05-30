CREATE TABLE `indexed_file` (
	`path` text PRIMARY KEY,
	`worktree` text NOT NULL,
	`language` text NOT NULL,
	`content_hash` text NOT NULL,
	`symbol_count` integer NOT NULL,
	`do_not_edit` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `symbol_reference` (
	`id` text PRIMARY KEY,
	`from_file` text NOT NULL,
	`from_line` integer NOT NULL,
	`from_symbol_id` text,
	`to_name` text NOT NULL,
	CONSTRAINT `fk_symbol_reference_from_file_indexed_file_path_fk` FOREIGN KEY (`from_file`) REFERENCES `indexed_file`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `symbol` (
	`id` text PRIMARY KEY,
	`file_path` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`signature` text,
	`line` integer NOT NULL,
	`column` integer NOT NULL,
	`end_line` integer NOT NULL,
	`exported` integer NOT NULL,
	`is_async` integer NOT NULL,
	`parent_id` text,
	`doc` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_symbol_file_path_indexed_file_path_fk` FOREIGN KEY (`file_path`) REFERENCES `indexed_file`(`path`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `indexed_file_worktree_idx` ON `indexed_file` (`worktree`);--> statement-breakpoint
CREATE INDEX `symbol_reference_to_name_idx` ON `symbol_reference` (`to_name`);--> statement-breakpoint
CREATE INDEX `symbol_reference_from_file_idx` ON `symbol_reference` (`from_file`);--> statement-breakpoint
CREATE INDEX `symbol_name_idx` ON `symbol` (`name`);--> statement-breakpoint
CREATE INDEX `symbol_file_path_idx` ON `symbol` (`file_path`);--> statement-breakpoint
CREATE INDEX `symbol_kind_idx` ON `symbol` (`kind`);