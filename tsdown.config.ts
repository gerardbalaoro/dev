import { defineConfig } from "tsdown";

export default defineConfig({
  dts: true,
  entry: ["src/cli.ts", "src/index.ts"],
  fixedExtension: false,
  format: "esm",
  platform: "node",
  target: "node24",
});
