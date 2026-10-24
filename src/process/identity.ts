import { readFile, readdir } from "node:fs/promises";
import { setInterval as interval } from "node:timers/promises";

import { execa } from "execa";
import { z } from "zod";

import { alive } from "@/process/signals";

export const IdentitySchema = z.object({
  groupToken: z.string().uuid().optional(),
  pid: z.number().int().positive(),
  startToken: z.string().optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

async function readLinuxProcess(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf-8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") {
      return;
    }
    return { group: Number(fields[2]), pid, started: fields[19] };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return;
    }
    throw error;
  }
}

async function get(pid: number): Promise<Identity> {
  if (process.platform === "linux") {
    const current = await readLinuxProcess(pid);
    if (!current) {
      return { pid };
    }
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf-8");
    const boot = bootId.trim();
    return { pid, startToken: `${boot}:${current.started}` };
  }
  // lstart is stable across ps calls; LC_ALL fixes its locale. Windows exposes creation ticks.
  const result =
    process.platform === "win32"
      ? await execa(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ],
          { reject: false }
        )
      : await execa("ps", ["-p", String(pid), "-o", "lstart="], {
          env: { LC_ALL: "C", TZ: "UTC" },
          reject: false,
        });
  if (result.exitCode === 0 && result.stdout.trim()) {
    return { pid, startToken: result.stdout.trim() };
  }
  if (!alive(pid)) {
    return { pid };
  }
  throw new Error(`Cannot verify process identity for PID ${pid}`);
}

async function matches(identity: Identity): Promise<boolean> {
  if (!alive(identity.pid)) {
    return false;
  }
  if (!identity.startToken) {
    throw new Error(
      `Cannot verify process identity for PID ${identity.pid}; refusing to signal a PID-only record`
    );
  }
  const current = await get(identity.pid);
  return current.startToken === identity.startToken;
}

async function getGroupMembers(group: number): Promise<number[]> {
  if (process.platform === "linux") {
    const processes = await readdir("/proc");
    const entries = processes.filter((entry) => /^\d+$/u.test(entry));
    const members = await Promise.all(
      entries.map((entry) => readLinuxProcess(Number(entry)))
    );
    return members.flatMap((entry) =>
      entry?.group === group ? [entry.pid] : []
    );
  }
  const { stdout } = await execa("ps", ["-axo", "pid=,pgid=,stat="], {
    env: { LC_ALL: "C", TZ: "UTC" },
  });
  return stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, pgid, state] = line.trim().split(/\s+/u);
      return Number(pgid) === group && !state?.startsWith("Z")
        ? [Number(pid)]
        : [];
    });
}

async function hasGroupToken(pid: number, token: string): Promise<boolean> {
  try {
    if (process.platform === "linux") {
      const env = await readFile(`/proc/${pid}/environ`, "utf-8");
      return env.split("\0").includes(`DEV_PROCESS_TOKEN=${token}`);
    }
    const { stdout } = await execa(
      "ps",
      ["-Eww", "-p", String(pid), "-o", "command="],
      { env: { LC_ALL: "C", TZ: "UTC" } }
    );
    return stdout.split(/\s+/u).includes(`DEV_PROCESS_TOKEN=${token}`);
  } catch {
    // Exited or inaccessible members cannot prove ownership.
    return false;
  }
}

async function stop(identity: Identity): Promise<void> {
  const current = await get(identity.pid);
  if (
    current.startToken &&
    identity.startToken &&
    current.startToken !== identity.startToken
  ) {
    // The original group leader has been replaced; never signal the replacement.
    return;
  }
  if (process.platform === "win32") {
    if (!current.startToken) {
      return;
    }
    if (!identity.startToken) {
      throw new Error(`Cannot verify process identity for PID ${identity.pid}`);
    }
    const result = await execa(
      "taskkill",
      ["/pid", String(identity.pid), "/T", "/F"],
      { reject: false }
    );
    if (result.exitCode && (await matches(identity))) {
      throw new Error(`Could not terminate process tree ${identity.pid}`);
    }
    return;
  }
  const members = await getGroupMembers(identity.pid);
  if (!members.length) {
    return;
  }
  if (!current.startToken || !identity.startToken) {
    const token = identity.groupToken;
    const evidence = token
      ? await Promise.all(members.map((pid) => hasGroupToken(pid, token)))
      : [];
    if (!evidence.some(Boolean)) {
      throw new Error(
        `Cannot verify ownership of process group ${identity.pid}; retaining recovery state`
      );
    }
  }
  const sendSignal = (signal: NodeJS.Signals) => {
    try {
      process.kill(-identity.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      ) {
        throw error;
      }
    }
  };
  sendSignal("SIGTERM");
  for await (const deadline of interval(25, Date.now() + 2000)) {
    const remaining = await getGroupMembers(identity.pid);
    if (!remaining.length) {
      return;
    }
    if (Date.now() >= deadline) {
      break;
    }
  }
  sendSignal("SIGKILL");
  for await (const deadline of interval(25, Date.now() + 2000)) {
    const remaining = await getGroupMembers(identity.pid);
    if (!remaining.length) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Process group ${identity.pid} has not exited; retaining recovery state`
      );
    }
  }
}

export const Identity = { get, matches, stop };
