import { defineConfig } from "tsdown";

export default defineConfig({
  dts: true,
  entry: ["src/cli.ts", "src/index.ts", "src/worker.ts"],
  fixedExtension: false,
  format: "esm",
  onSuccess: "tsx src/skills.ts",
  platform: "node",
  target: "node24",
});
