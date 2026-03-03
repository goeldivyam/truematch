import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: ["plugin/**", "node_modules/**"],
    env: {
      // Provide a test-only encryption key so tests don't need a real .env
      CONTACT_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  },
});
