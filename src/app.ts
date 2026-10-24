import { Crust } from "@crustjs/core";
import { help, version } from "@crustjs/extensions";
import { skill } from "@crustjs/skills";

import Metadata from "#package" with { type: "json" };
import Exec from "@/commands/exec";
import Start from "@/commands/start";
import Status from "@/commands/status";
import Stop from "@/commands/stop";

export const App = new Crust("dev", {
  description: Metadata.description,
  sections: [
    {
      body: "Arguments after exec are passed directly to the child command.",
      title: "Command help",
    },
    { body: Metadata.homepage, title: "Documentation" },
  ],
  version: Metadata.version,
})
  .extend(version(), help(), skill({}))
  .add(Start, Stop, Status, Exec);
