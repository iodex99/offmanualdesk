CREATE TYPE "public"."principal_kind" AS ENUM('console', 'firm_admin');--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" "principal_kind" NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "console_users" ADD COLUMN "totp_last_counter" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "firm_admins" ADD COLUMN "totp_last_counter" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("kind","user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry" ON "sessions" USING btree ("expires_at");