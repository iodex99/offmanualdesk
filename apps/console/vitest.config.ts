import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test boots PGlite (Postgres in WASM) and applies migrations: allow for slow CI machines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
