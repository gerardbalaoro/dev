import { defineCommand } from "@crustjs/core";

import { context } from "@/context";
import { Sessions } from "@/session/store";
import { UI } from "@/ui/index";

async function status(cwd = process.cwd(), ui: UI = UI): Promise<number> {
  const { git, store } = await context(cwd);
  const session = await store.read();
  ui.start(session?.workspace ?? git.root);

  if (!session || !(await Sessions.alive(session))) {
    ui.info(
      session
        ? "Session stopped with unfinished cleanup. Run `dev stop` to clean up."
        : "No active session. Run `dev start` to begin."
    );
  } else {
    ui.info(`Status  ${session.status}\nPID     ${session.pid}`);
    ui.showEndpoints(session.endpoints);
  }

  return 0;
}

export default defineCommand(
  "status",
  { description: "Show session status and local URLs" },
  (command) =>
    command.action(async () => {
      process.exitCode = await status();
    })
);
