import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm", "cjs"],
    sourcemap: true,
    target: "es2022",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
