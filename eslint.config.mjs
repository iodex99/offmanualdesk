// ESLint flat config for every TypeScript/JavaScript package in the monorepo.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/target/**",
      "**/src-tauri/gen/**",
      "**/coverage/**",
      "skills/vendored/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // No silent catch (BUILD_PROMPT definition of done): empty blocks must say why.
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      // Logs must never carry client content; use the package logger, not console.
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["apps/desk/ui/**/*.{ts,tsx}", "apps/console/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // Scripts and hooks are CLIs: printing is their job.
    files: [".claude/hooks/**/*.mjs", "tools/**/*.mjs", "**/scripts/**/*.mjs", "**/*.config.{js,mjs,ts}"],
    rules: { "no-console": "off" },
  },
);
