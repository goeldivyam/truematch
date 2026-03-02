// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript-aware rules across all TS/JS files
  ...tseslint.configs.recommended,

  // Global ignores — never lint generated output or tooling dirs
  {
    ignores: [
      "dist/**",
      "build/**",
      "coverage/**",
      ".pnpm-store/**",
      "node_modules/**",
    ],
  },

  // Project-wide rule overrides
  {
    rules: {
      // Allow `_`-prefixed variables to be unused (common for destructuring)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Require explicit return types on exported functions so the public API
      // surface is always typed — but allow inference inside function bodies.
      "@typescript-eslint/explicit-module-boundary-types": "warn",

      // Disallow `any` — use `unknown` instead and narrow explicitly.
      "@typescript-eslint/no-explicit-any": "error",

      // Prefer `import type` for type-only imports (helps with ESM tree-shaking).
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
);
