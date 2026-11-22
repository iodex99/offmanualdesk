ALTER TABLE "support_tickets" ADD COLUMN "ref" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "bundle" jsonb;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_ref_unique" UNIQUE("ref");