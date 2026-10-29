import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "c12";
import { z } from "zod";

import { merge } from "@/config/merge";
import { ConfigSchema } from "@/config/schema";
import type { Config, Extension } from "@/config/types";

export async function load(root: string, extension: Extension = {}): Promise<Config> {
  const packageConfig = await (async () => {
    try {
      const contents = await readFile(path.join(root, "package.json"), "utf-8");
      return (
        z.object({ dev: z.record(z.string(), z.unknown()).optional() }).parse(JSON.parse(contents))
          .dev ?? {}
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  })();
  const { config } = await loadConfig<Extension>({
    cwd: root,
    defaultConfig: packageConfig,
    dotenv: false,
    name: "dev",
    packageJson: false,
    rcFile: false,
  });
  const result = ConfigSchema.safeParse(merge(config, extension));
  if (!result.success) {
    throw new Error(
      `Invalid dev configuration. Check the dev field in package.json or dev.config.* at the workspace root:\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`
    );
  }
  return result.data;
}
