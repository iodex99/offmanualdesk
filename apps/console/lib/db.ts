// Database handle. Production: postgres.js on DATABASE_URL. Tests pass a PGlite
// drizzle instance to the handlers instead (see test/helpers/db.ts).
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "@/db/schema";

export type Schema = typeof schema;
export type DB = PgDatabase<PgQueryResultHKT, Schema>;

let cached: PostgresJsDatabase<Schema> | undefined;

export function getDb(): DB {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cached = drizzle(postgres(url, { max: 5, prepare: false }), { schema });
  }
  return cached as unknown as DB;
}
