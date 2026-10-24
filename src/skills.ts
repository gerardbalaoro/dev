import { writeSkills } from "@crustjs/skills";

import Metadata from "#package" with { type: "json" };
import { App } from "@/app";

await writeSkills({
  app: App,
  outDir: ".crust/root/skills",
  version: Metadata.version,
});
