CREATE TYPE "public"."notice_audience" AS ENUM('all', 'admins');--> statement-breakpoint
CREATE TYPE "public"."notice_kind" AS ENUM('update', 'billing', 'admin');--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firm_id" uuid,
	"kind" "notice_kind" NOT NULL,
	"audience" "notice_audience" DEFAULT 'all' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"dedupe_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notices_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;