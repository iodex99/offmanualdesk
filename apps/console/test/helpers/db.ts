// Real Postgres for tests: PGlite (Postgres compiled to WASM) with the generated
// Drizzle migrations applied, so schema and SQL are exercised for real.
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { DB } from "@/lib/db";

export async function testDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../db/migrations", import.meta.url)) });
  return { db: db as unknown as DB, close: () => client.close() };
}
