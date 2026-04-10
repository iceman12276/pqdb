import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    exclude: ["tests/e2e/**", "node_modules/**"],
    alias: {
      "@pqdb/client": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
});
