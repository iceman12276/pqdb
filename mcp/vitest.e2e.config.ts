import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Resolve @pqdb/client to its source (not dist) for vitest
      "@pqdb/client": path.resolve(__dirname, "../sdk/src/index.ts"),
    },
  },
});
