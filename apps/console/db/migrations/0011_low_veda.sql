ALTER TABLE "invoices" ADD COLUMN "payment_link_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_link_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref" ON "payments" USING btree ("provider","provider_ref");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_link_id_unique" UNIQUE("payment_link_id");