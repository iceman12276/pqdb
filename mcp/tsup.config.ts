import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  banner: ({ format }) => {
    // Add shebang to CLI entry for ESM output
    if (format === "esm") {
      return { js: "" };
    }
    return {};
  },
});
