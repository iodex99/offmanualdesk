// Console database (docs/DATA_MODEL.md §1). Every change here needs a migration
// (`pnpm --filter @offmanual/console db:generate`) and a DATA_MODEL.md update in the
// same commit (.claude/rules/console.md).
//
// IDs: uuid (v7, generated in the app). Times: timestamptz, UTC. Money: paise (bigint)
// in billing tables (M9). Secrets: *_enc columns hold envelope-encrypted values.
// The console never stores client content: no prompts, file names or contents.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---- identity and tenancy ----

export const consoleRole = pgEnum("console_role", ["superadmin", "staff"]);
export const firmStatus = pgEnum("firm_status", [
  "trial",
  "active",
  "overdue",
  "restricted",
  "suspended",
  "closed",
]);
export const llmKeyMode = pgEnum("llm_key_mode", ["firm", "offmanual"]);
export const firmAdminRole = pgEnum("firm_admin_role", ["owner", "admin"]);
export const health = pgEnum("server_health", ["green", "amber", "red"]);
export const employeeStatus = pgEnum("employee_status", ["invited", "active", "disabled"]);
export const inviteChannel = pgEnum("invite_channel", ["email", "whatsapp"]);

export const consoleUsers = pgTable("console_users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: consoleRole("role").notNull(),
  totpSecretEnc: text("totp_secret_enc"),
  totpEnrolledAt: timestamp("totp_enrolled_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const firms = pgTable("firms", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  legalName: text("legal_name").notNull(),
  gstin: text("gstin"),
  stateCode: text("state_code").notNull(),
  billingEmail: text("billing_email").notNull(),
  billingPhone: text("billing_phone"),
  status: firmStatus("status").notNull().default("trial"),
  rolloutRing: integer("rollout_ring").notNull().default(2),
  versionPin: text("version_pin"),
  dataNoteSignedAt: timestamp("data_note_signed_at", { withTimezone: true }),
  llmKeyMode: llmKeyMode("llm_key_mode").notNull().default("firm"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const firmAdmins = pgTable(
  "firm_admins",
  {
    id: uuid("id").primaryKey(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: firmAdminRole("role").notNull().default("admin"),
    totpSecretEnc: text("totp_secret_enc"),
    totpEnrolledAt: timestamp("totp_enrolled_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("firm_admins_firm_email").on(t.firmId, t.email)],
);

export const servers = pgTable(
  "servers",
  {
    id: uuid("id").primaryKey(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    hostname: text("hostname").notNull(),
    publicKey: text("public_key").notNull().unique(), // base64 raw ed25519 (ADR-013/035)
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    agentVersion: text("agent_version"),
    openclawVersion: text("openclaw_version"),
    deskVersion: text("desk_version"),
    stagedVersion: text("staged_version"),
    health: health("health").notNull().default("amber"),
    activeSeats: integer("active_seats").notNull().default(0),
    preflightJson: jsonb("preflight_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("servers_firm").on(t.firmId)],
);

export const enrolmentCodes = pgTable("enrolment_codes", {
  id: uuid("id").primaryKey(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firms.id),
  serverName: text("server_name").notNull(),
  codeHash: text("code_hash").notNull().unique(), // sha256 hex of the code; the code itself is shown once
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  serverId: uuid("server_id").references(() => servers.id),
  createdAt: createdAt(),
});

export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    windowsSid: text("windows_sid"),
    windowsUsername: text("windows_username"),
    roleLabel: text("role_label"),
    oauthProvider: text("oauth_provider"),
    oauthSubject: text("oauth_subject"),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    totpSecretEnc: text("totp_secret_enc"),
    totpEnrolledAt: timestamp("totp_enrolled_at", { withTimezone: true }),
    telegramLinked: boolean("telegram_linked").notNull().default(false),
    status: employeeStatus("status").notNull().default("invited"),
    enabledFrom: date("enabled_from"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("employees_firm_email").on(t.firmId, t.email),
    uniqueIndex("employees_firm_sid")
      .on(t.firmId, t.windowsSid)
      .where(sql`${t.windowsSid} is not null`),
  ],
);

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  channel: inviteChannel("channel").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ---- capabilities and policy ----

export const skillPacks = pgTable("skill_packs", {
  key: text("key").primaryKey(), // core, tally-read, tally-post, email-send, portals, admin
  name: text("name").notNull(),
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  actions: jsonb("actions").$type<string[]>().notNull().default([]),
  reviewRequired: jsonb("review_required").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const packGrants = pgTable(
  "pack_grants",
  {
    id: uuid("id").primaryKey(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    packKey: text("pack_key")
      .notNull()
      .references(() => skillPacks.key),
    adGroup: text("ad_group"),
    employeeId: uuid("employee_id").references(() => employees.id),
    createdAt: createdAt(),
  },
  (t) => [index("pack_grants_firm").on(t.firmId)],
);

export const telegramMode = pgEnum("telegram_mode", ["off", "text", "files"]);

export const firmPolicies = pgTable("firm_policies", {
  firmId: uuid("firm_id")
    .primaryKey()
    .references(() => firms.id),
  lockTimeoutMaxMin: integer("lock_timeout_max_min").notNull().default(15),
  dayEndHourIst: integer("day_end_hour_ist").notNull().default(22),
  telegramMode: telegramMode("telegram_mode").notNull().default("text"),
  telegramUnlockMaxMin: integer("telegram_unlock_max_min").notNull().default(60),
  telegramAllowedPacks: jsonb("telegram_allowed_packs").$type<string[]>().notNull().default(["core"]),
  stepUpActions: jsonb("step_up_actions").$type<string[]>().notNull().default([]),
  gatewayIdleStopHours: integer("gateway_idle_stop_hours").notNull().default(4),
  retentionDays: integer("retention_days").notNull().default(180),
  version: integer("version").notNull().default(1), // bumps on every change; drives the agent's ETag
  updatedAt: updatedAt(),
});

// ---- agent API support ----

export const agentNonces = pgTable(
  "agent_nonces",
  {
    serverId: uuid("server_id").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.nonce] }), index("agent_nonces_expiry").on(t.expiresAt)],
);

// ---- releases ----

export const releaseSeverity = pgEnum("release_severity", ["normal", "security"]);

export const releases = pgTable("releases", {
  id: uuid("id").primaryKey(),
  version: text("version").notNull().unique(),
  channel: text("channel").notNull().default("stable"),
  severity: releaseSeverity("severity").notNull().default("normal"),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  manifestUrl: text("manifest_url"),
  payloadSha256: text("payload_sha256").notNull(),
  keyId: text("key_id").notNull(),
  changelogMd: text("changelog_md").notNull().default(""),
  openclawVersion: text("openclaw_version").notNull(),
  createdAt: createdAt(),
});

export const releaseRings = pgTable(
  "release_rings",
  {
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id),
    ring: integer("ring").notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }).notNull().defaultNow(),
    promotedBy: uuid("promoted_by").references(() => consoleUsers.id),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.ring] })],
);

// ---- usage, audit, support (counts only) ----

export const usageDaily = pgTable(
  "usage_daily",
  {
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    date: date("date").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    turns: integer("turns").notNull().default(0),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.date] })],
);

export const seatDays = pgTable(
  "seat_days",
  {
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    date: date("date").notNull(),
    enabled: boolean("enabled").notNull(),
    active: boolean("active").notNull(),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.date] })],
);

export const auditSummaries = pgTable(
  "audit_summaries",
  {
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id),
    date: date("date").notNull(),
    category: text("category").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.date, t.category] })],
);

export const supportTickets = pgTable("support_tickets", {
  id: uuid("id").primaryKey(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firms.id),
  serverId: uuid("server_id").references(() => servers.id),
  employeeId: uuid("employee_id").references(() => employees.id),
  bundleUrl: text("bundle_url"),
  status: text("status").notNull().default("open"),
  notes: text("notes").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
