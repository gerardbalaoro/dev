import { defineCommand } from "@crustjs/core";

import { watch } from "@/process/signals";
import { launch } from "@/session/launch";
import { UI } from "@/ui/index";

async function start(cwd = process.cwd(), ui: UI = UI): Promise<number> {
  const signals = watch();

  try {
    const session = await launch(cwd, {}, ui, signals.signal);
    ui.info("Session running. Press Ctrl+C to stop and clean up.");
    const result = await session.exited;

    return signals.getExitCode() || result.code;
  } catch (error) {
    if (!signals.signal.aborted) {
      ui.error(error instanceof Error ? error.message : String(error));
    }

    return signals.getExitCode() || 1;
  } finally {
    signals.dispose();
  }
}

export default defineCommand(
  "start",
  { description: "Start development in this workspace" },
  (command) =>
    command.action(async () => {
      process.exitCode = await start();
    })
);
