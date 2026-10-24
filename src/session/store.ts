import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import envPaths from "env-paths";

import { Identity } from "@/process/identity";
import { SessionSchema } from "@/session/schema";
import type { Session } from "@/session/types";
import { hash } from "@/utils/hash";
import type { Workspace } from "@/workspace/resolve";

function directory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.DEV_STATE_DIR) {
    return environment.DEV_STATE_DIR;
  }
  if (process.platform === "linux") {
    return path.join(
      environment.XDG_STATE_HOME || path.join(homedir(), ".local", "state"),
      "dev"
    );
  }
  return envPaths("dev", { suffix: "" }).data;
}

export class Store {
  readonly workspace: Pick<Workspace, "root">;

  readonly directory: string;
  readonly file: string;
  readonly lockTarget: string;
  readonly routesDirectory: string;
  constructor(workspace: Pick<Workspace, "root">, base = directory()) {
    this.workspace = workspace;

    // Key by canonical root, so changing config.name cannot bypass an active lock.
    this.directory = path.join(base, "workspaces", hash(workspace.root));
    this.file = path.join(this.directory, "session.json");
    this.lockTarget = path.join(this.directory, "owner");
    this.routesDirectory = path.join(base, "routes");
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
  }

  async read(): Promise<Session | undefined> {
    try {
      const parsed = SessionSchema.parse(
        JSON.parse(await readFile(this.file, "utf-8"))
      );
      if (parsed.root !== this.workspace.root) {
        throw new Error("Session workspace root does not match");
      }
      return parsed;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw new Error(
        `Cannot read session ${this.file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  async write(session: Session): Promise<void> {
    await this.prepare();
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(session, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async remove(id: string): Promise<void> {
    const session = await this.read();
    if (session?.id === id) {
      await rm(this.file, { force: true });
    }
  }
}

function alive(session: Session): Promise<boolean> {
  return Identity.matches({
    pid: session.pid,
    startToken: session.ownerStartToken,
  });
}

async function get(
  workspace: Pick<Workspace, "root">
): Promise<Session | undefined> {
  const session = await new Store(workspace).read();
  return session && (await alive(session)) ? session : undefined;
}

async function env(
  workspace: Pick<Workspace, "root">
): Promise<Record<string, string>> {
  const session = await get(workspace);
  if (!session || session.status !== "running") {
    throw new Error(
      `No active dev session for "${session?.workspace ?? workspace.root}".\nRun \`dev start\` first.`
    );
  }
  return { ...session.env };
}

export const Sessions = { alive, directory, env, get };
