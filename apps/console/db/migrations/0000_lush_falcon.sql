CREATE TYPE "public"."console_role" AS ENUM('superadmin', 'staff');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."firm_admin_role" AS ENUM('owner', 'admin');--> statement-breakpoint
CREATE TYPE "public"."firm_status" AS ENUM('trial', 'active', 'overdue', 'restricted', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."server_health" AS ENUM('green', 'amber', 'red');--> statement-breakpoint
CREATE TYPE "public"."invite_channel" AS ENUM('email', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."llm_key_mode" AS ENUM('firm', 'offmanual');--> statement-breakpoint
CREATE TYPE "public"."release_severity" AS ENUM('normal', 'security');--> statement-breakpoint
CREATE TYPE "public"."telegram_mode" AS ENUM('off', 'text', 'files');--> statement-breakpoint
CREATE TABLE "agent_nonces" (
	"server_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_nonces_server_id_nonce_pk" PRIMARY KEY("server_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "audit_summaries" (
	"firm_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"date" date NOT NULL,
	"category" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "audit_summaries_server_id_date_category_pk" PRIMARY KEY("server_id","date","category")
);
--> statement-breakpoint
CREATE TABLE "console_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "console_role" NOT NULL,
	"totp_secret_enc" text,
	"totp_enrolled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "console_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"windows_sid" text,
	"windows_username" text,
	"role_label" text,
	"oauth_provider" text,
	"oauth_subject" text,
	"bound_at" timestamp with time zone,
	"totp_secret_enc" text,
	"totp_enrolled_at" timestamp with time zone,
	"telegram_linked" boolean DEFAULT false NOT NULL,
	"status" "employee_status" DEFAULT 'invited' NOT NULL,
	"enabled_from" date,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrolment_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firm_id" uuid NOT NULL,
	"server_name" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"server_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrolment_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "firm_admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firm_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "firm_admin_role" DEFAULT 'admin' NOT NULL,
	"totp_secret_enc" text,
	"totp_enrolled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firm_policies" (
	"firm_id" uuid PRIMARY KEY NOT NULL,
	"lock_timeout_max_min" integer DEFAULT 15 NOT NULL,
	"day_end_hour_ist" integer DEFAULT 22 NOT NULL,
	"telegram_mode" "telegram_mode" DEFAULT 'text' NOT NULL,
	"telegram_unlock_max_min" integer DEFAULT 60 NOT NULL,
	"telegram_allowed_packs" jsonb DEFAULT '["core"]'::jsonb NOT NULL,
	"step_up_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gateway_idle_stop_hours" integer DEFAULT 4 NOT NULL,
	"retention_days" integer DEFAULT 180 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_name" text NOT NULL,
	"gstin" text,
	"state_code" text NOT NULL,
	"billing_email" text NOT NULL,
	"billing_phone" text,
	"status" "firm_status" DEFAULT 'trial' NOT NULL,
	"rollout_ring" integer DEFAULT 2 NOT NULL,
	"version_pin" text,
	"data_note_signed_at" timestamp with time zone,
	"llm_key_mode" "llm_key_mode" DEFAULT 'firm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"channel" "invite_channel" NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firm_id" uuid NOT NULL,
	"pack_key" text NOT NULL,
	"ad_group" text,
	"employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_rings" (
	"release_id" uuid NOT NULL,
	"ring" integer NOT NULL,
	"promoted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_by" uuid,
	CONSTRAINT "release_rings_release_id_ring_pk" PRIMARY KEY("release_id","ring")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"channel" text DEFAULT 'stable' NOT NULL,
	"severity" "release_severity" DEFAULT 'normal' NOT NULL,
	"deadline_at" timestamp with time zone,
	"manifest_url" text,
	"payload_sha256" text NOT NULL,
	"key_id" text NOT NULL,
	"changelog_md" text DEFAULT '' NOT NULL,
	"openclaw_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "seat_days" (
	"firm_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"enabled" boolean NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "seat_days_employee_id_date_pk" PRIMARY KEY("employee_id","date")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firm_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"public_key" text NOT NULL,
	"enrolled_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"agent_version" text,
	"openclaw_version" text,
	"desk_version" text,
	"staged_version" text,
	"health" "server_health" DEFAULT 'amber' NOT NULL,
	"active_seats" integer DEFAULT 0 NOT NULL,
	"preflight_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servers_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "skill_packs" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"firm_id" uuid NOT NULL,
	"server_id" uuid,
	"employee_id" uuid,
	"bundle_url" text,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"firm_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"tasks_completed" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_employee_id_date_pk" PRIMARY KEY("employee_id","date")
);
--> statement-breakpoint
ALTER TABLE "audit_summaries" ADD CONSTRAINT "audit_summaries_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_summaries" ADD CONSTRAINT "audit_summaries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_admins" ADD CONSTRAINT "firm_admins_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "firm_policies" ADD CONSTRAINT "firm_policies_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_grants" ADD CONSTRAINT "pack_grants_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_grants" ADD CONSTRAINT "pack_grants_pack_key_skill_packs_key_fk" FOREIGN KEY ("pack_key") REFERENCES "public"."skill_packs"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_grants" ADD CONSTRAINT "pack_grants_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_rings" ADD CONSTRAINT "release_rings_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_rings" ADD CONSTRAINT "release_rings_promoted_by_console_users_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "public"."console_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_days" ADD CONSTRAINT "seat_days_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_days" ADD CONSTRAINT "seat_days_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_nonces_expiry" ON "agent_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_firm_email" ON "employees" USING btree ("firm_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_firm_sid" ON "employees" USING btree ("firm_id","windows_sid") WHERE "employees"."windows_sid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "firm_admins_firm_email" ON "firm_admins" USING btree ("firm_id","email");--> statement-breakpoint
CREATE INDEX "pack_grants_firm" ON "pack_grants" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "servers_firm" ON "servers" USING btree ("firm_id");