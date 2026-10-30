import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { setInterval as interval } from "node:timers/promises";

import { execa } from "execa";

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  shouldCapture?: boolean;
  onSpawn?: (pid: number, groupToken: string) => Promise<void>;
  onSettled?: () => Promise<void>;
  shouldInherit?: boolean;
  onOutput?: (chunk: string) => void;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecutionOptions = Omit<RunOptions, "onSpawn" | "onSettled">;

export type Executor = (
  command: string | string[],
  options: ExecutionOptions
) => Promise<ProcessResult>;

const MaxCapture = 1024 * 1024;

const getSignalExitCode = (signal?: string): number => {
  if (signal === undefined || signal === "") {
    return 1;
  }

  const entry = Object.entries(constants.signals).find(([name]) => name === signal);

  return 128 + (entry?.[1] ?? 1);
};

function parseCommand(command: string | string[]) {
  const shouldUseShell = !Array.isArray(command);
  const [file, ...args] = Array.isArray(command) ? command : [command];

  if (file === undefined || file === "") {
    throw new Error("A command is required");
  }

  return { args, file, shouldUseShell };
}

export async function run(command: string | string[], options: RunOptions): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  const invocation = parseCommand(command);
  const output = options.shouldInherit === true ? "inherit" : "pipe";
  const groupToken = randomUUID();

  const child = execa(invocation.file, invocation.args, {
    buffer: false,
    cwd: options.cwd,
    env: { ...options.env, DEV_PROCESS_TOKEN: groupToken },
    extendEnv: false,
    forceKillAfterDelay: 2000,
    killDescendants: true,
    reject: false,
    shell: invocation.shouldUseShell,
    stderr: output,
    stdin: "inherit",
    stdout: output,
  });

  let stdout = "";
  let stderr = "";
  let hasOverflow = false;
  let capturedBytes = 0;

  const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    child.kill(signal);
  };

  let killTimer: NodeJS.Timeout | undefined;

  const abort = () => {
    stop();
    killTimer ??= setTimeout(() => {
      stop("SIGKILL");
    }, 2000);
    killTimer.unref();
  };

  const createSink = (channel: "stdout" | "stderr") => {
    const decoder = new StringDecoder("utf-8");

    return (chunk: Buffer) => {
      const text = decoder.write(chunk);
      options.onOutput?.(text);

      if (options.shouldCapture === true && !hasOverflow) {
        capturedBytes += chunk.length;

        if (capturedBytes > MaxCapture) {
          hasOverflow = true;
          abort();

          return;
        }

        if (channel === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }
      }
    };
  };

  const reap = async () => {
    // The shell may exit before its descendants. Always reap the process group.
    stop();

    if (process.platform !== "win32" && child.pid !== undefined) {
      for await (const deadline of interval(25, Date.now() + 2000)) {
        if (Date.now() >= deadline) {
          break;
        }

        try {
          process.kill(-child.pid, 0);
        } catch {
          break;
        }
      }

      stop("SIGKILL");
    }
  };

  child.nodeChildProcess.stdout?.on("data", createSink("stdout"));
  child.nodeChildProcess.stderr?.on("data", createSink("stderr"));
  child.nodeChildProcess.once("exit", abort);
  options.signal?.addEventListener("abort", abort, { once: true });

  if (options.signal?.aborted === true) {
    abort();
  }

  try {
    if (child.pid !== undefined && options.onSpawn) {
      try {
        await options.onSpawn(child.pid, groupToken);
      } catch (error) {
        abort();
        await child;
        throw error;
      }
    }

    const result = await child;
    await reap();

    if (hasOverflow) {
      throw new Error("Command output exceeded the 1 MiB capture limit");
    }

    if (result.failed && result.exitCode === undefined && !result.signal) {
      throw new Error(`Unable to execute ${invocation.file}: ${result.shortMessage}`);
    }

    return {
      code: result.exitCode ?? getSignalExitCode(result.signal),
      stderr,
      stdout,
    };
  } finally {
    if (killTimer) {
      clearTimeout(killTimer);
    }

    options.signal?.removeEventListener("abort", abort);
    await options.onSettled?.();
  }
}
