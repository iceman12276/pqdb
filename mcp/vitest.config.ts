import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Default config runs UNIT tests only. E2E tests live under
    // tests/e2e/ and are run separately via `npm run test:e2e -w mcp`
    // because they require a running backend + Postgres + Vault.
    // Splitting them keeps `npm test` fast (~1s) and runnable in CI
    // without infrastructure.
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**/*.test.ts", "node_modules/**"],
  },
  resolve: {
    alias: {
      // Resolve @pqdb/client to its source (not dist) for vitest
      "@pqdb/client": path.resolve(__dirname, "../sdk/src/index.ts"),
    },
  },
});
