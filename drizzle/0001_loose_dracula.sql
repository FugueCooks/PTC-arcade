ALTER TABLE "users" ADD COLUMN "username" varchar(18);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "normalized_username" varchar(18);--> statement-breakpoint
WITH ranked_users AS (
	SELECT "id", "display_name",
		row_number() OVER (
			PARTITION BY lower(regexp_replace("display_name", '[^A-Za-z0-9_.-]', '_', 'g'))
			ORDER BY "created_at", "id"
		) AS duplicate_number
	FROM "users"
)
UPDATE "users" AS target
SET "username" = CASE
		WHEN ranked_users.duplicate_number = 1 THEN left(regexp_replace(ranked_users."display_name", '[^A-Za-z0-9_.-]', '_', 'g'), 18)
		ELSE left(regexp_replace(ranked_users."display_name", '[^A-Za-z0-9_.-]', '_', 'g'), 9) || '_' || left(replace(target."id"::text, '-', ''), 8)
	END
FROM ranked_users
WHERE target."id" = ranked_users."id";--> statement-breakpoint
UPDATE "users" SET "normalized_username" = lower("username");--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "normalized_username" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_normalized_username_unique" ON "users" USING btree ("normalized_username");
