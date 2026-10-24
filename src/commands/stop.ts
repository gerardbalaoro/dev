import { setInterval as interval } from "node:timers/promises";

import { defineCommand } from "@crustjs/core";

import { context } from "@/context";
import { Journal } from "@/session/lifecycle";
import { acquire } from "@/session/lock";
import { Sessions } from "@/session/store";
import { UI } from "@/ui/index";

async function stop(cwd = process.cwd(), ui: UI = UI): Promise<number> {
  const { git, store } = await context(cwd);
  let session = await store.read();
  if (!session) {
    ui.info(`No active session for "${git.root}".`);
    return 0;
  }
  const { id } = session;
  if (await Sessions.alive(session)) {
    try {
      process.kill(session.pid, "SIGTERM");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      ) {
        throw error;
      }
    }
    for await (const deadline of interval(100, Date.now() + 45_000)) {
      if (!(await Sessions.alive(session)) || Date.now() >= deadline) {
        break;
      }
      const current = await store.read();
      if (!current || current.id !== id) {
        ui.info("Session stopped. Cleanup complete.");
        return 0;
      }
    }
    if (await Sessions.alive(session)) {
      throw new Error(
        `Session ${session.pid} is still shutting down; inspect its terminal`
      );
    }
  }
  const release = await acquire(store);
  try {
    session = await store.read();
    if (session?.id === id) {
      if (await Sessions.alive(session)) {
        throw new Error(
          "The session is still running. Run `dev status` for details."
        );
      }
      if (!(await new Journal(session, store).cleanup(ui))) {
        return 1;
      }
    }
  } finally {
    await release();
  }
  ui.info("Session stopped. Cleanup complete.");
  return 0;
}

export default defineCommand(
  "stop",
  { description: "Stop the session and clean up this workspace" },
  (command) =>
    command.action(async () => {
      process.exitCode = await stop();
    })
);
