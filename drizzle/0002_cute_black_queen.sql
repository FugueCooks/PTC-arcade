CREATE TABLE "wallet_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain" varchar(32) DEFAULT 'solana' NOT NULL,
	"network" varchar(32) NOT NULL,
	"wallet_address" varchar(64) NOT NULL,
	"normalized_wallet_address" varchar(64) NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "normalized_username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "normalized_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "public_player_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_identities" ADD CONSTRAINT "wallet_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_identities_chain_network_address_unique" ON "wallet_identities" USING btree ("chain","network","normalized_wallet_address");--> statement-breakpoint
CREATE INDEX "wallet_identities_user_id_idx" ON "wallet_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_public_player_id_unique" ON "users" USING btree ("public_player_id");