import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and the built UI in ../dist (see src-tauri/tauri.conf.json).
export default defineConfig({
  root: "ui",
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
  test: {
    root: ".",
    include: ["ui/**/*.test.{ts,tsx}"],
    environment: "jsdom",
  },
});
