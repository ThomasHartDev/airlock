import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node20",
    dts: false,
    clean: false,
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
