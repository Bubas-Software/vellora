CREATE TABLE `user_role_memberships` (
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`granted_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `role`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "user_role_memberships_role_check" CHECK("user_role_memberships"."role" IN ('admin','coordenador_operacional','familia','cuidador')),
	CONSTRAINT "user_role_memberships_active_check" CHECK("user_role_memberships"."active" IN (0,1)),
	CONSTRAINT "user_role_memberships_default_check" CHECK("user_role_memberships"."is_default" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `idx_user_role_memberships_active` ON `user_role_memberships` (`user_id`,`active`);
--> statement-breakpoint
-- Add a default membership for every existing user without changing the
-- users row or any business records that reference its ID.
INSERT INTO `user_role_memberships` (`user_id`, `role`, `active`, `is_default`)
SELECT `id`, `role`, 1, 1 FROM `users` WHERE 1 = 1
ON CONFLICT(`user_id`, `role`) DO NOTHING;
--> statement-breakpoint
-- New users receive their initial role membership automatically. This also
-- covers existing account-creation paths that insert directly into users.
CREATE TRIGGER `users_seed_default_role_membership`
AFTER INSERT ON `users`
BEGIN
	INSERT INTO `user_role_memberships` (`user_id`, `role`, `active`, `is_default`)
	VALUES (NEW.`id`, NEW.`role`, 1, 1)
	ON CONFLICT(`user_id`, `role`) DO NOTHING;
END;
