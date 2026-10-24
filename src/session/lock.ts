import lockfile from "proper-lockfile";

import { Sessions } from "@/session/store";
import type { Store } from "@/session/store";

export function running(workspace: string, pid?: number): Error {
  return new Error(
    `Workspace "${workspace}" is already running or starting.${pid ? `\nPID: ${pid}` : ""}\nRun \`dev status\` for details.`
  );
}

export async function acquire(store: Store): Promise<() => Promise<void>> {
  await store.prepare();
  const active = await store.read();
  if (active && (await Sessions.alive(active))) {
    throw running(active.workspace, active.pid);
  }
  try {
    return await lockfile.lock(store.lockTarget, {
      realpath: false,
      retries: { factor: 1, maxTimeout: 1000, minTimeout: 1000, retries: 7 },
      stale: 5000,
      update: 1000,
    });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ELOCKED")
    ) {
      throw error;
    }
    const session = await store.read();
    throw running(session?.workspace ?? store.workspace.root, session?.pid);
  }
}
