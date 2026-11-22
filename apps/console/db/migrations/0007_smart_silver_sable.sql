CREATE TABLE "digest_runs" (
	"firm_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "digest_runs_firm_id_week_start_pk" PRIMARY KEY("firm_id","week_start")
);
--> statement-breakpoint
ALTER TABLE "digest_runs" ADD CONSTRAINT "digest_runs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;