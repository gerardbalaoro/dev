/* oxlint-disable promise/prefer-await-to-then -- Observe completion errors while waiting for process readiness. */
import { foreground } from "@/process/foreground";
import { run } from "@/process/run";
import type { ExecutionOptions, Executor, ProcessResult } from "@/process/run";
import type { Journal } from "@/session/lifecycle";
import type { UI } from "@/ui/index";

export class Execution {
  private readonly journal: Journal;
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<ProcessResult>>();
  private serial?: Promise<ProcessResult>;
  readonly signal: AbortSignal;

  constructor(journal: Journal, signal?: AbortSignal) {
    this.journal = journal;
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
  }

  readonly run: Executor = async (command, options) => await this.execute(command, options, false);

  async exec(command: string[], options: ExecutionOptions): Promise<ProcessResult> {
    return await this.execute(command, { ...options, shouldCapture: true }, true);
  }

  async start(
    command: string,
    options: ExecutionOptions,
    ui: UI
  ): Promise<{ exited: Promise<number> }> {
    const ready = Promise.withResolvers<boolean>();
    const exited = foreground(
      command,
      options,
      ui,
      false,
      async (script, settings) =>
        await this.execute(script, settings, false, () => {
          ready.resolve(true);
        })
    );
    void exited.catch(() => {
      // The caller observes the original rejection after startup.
    });
    await Promise.race([ready.promise, exited]);
    return { exited };
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.pending);
  }

  private async execute(
    command: string | string[],
    options: ExecutionOptions,
    isConcurrent: boolean,
    onReady?: () => void
  ): Promise<ProcessResult> {
    if (this.signal.aborted) {
      throw new Error("The session has stopped");
    }
    if (!isConcurrent && this.serial) {
      throw new Error("A managed process is already active in this session");
    }
    const observer = isConcurrent ? this.journal.observeCommand() : this.journal.observe();
    const task = run(command, {
      ...options,
      ...observer,
      async onSpawn(pid, token) {
        await observer.onSpawn?.(pid, token);
        onReady?.();
      },
      signal: options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal,
    });
    this.pending.add(task);
    if (!isConcurrent) {
      this.serial = task;
    }
    try {
      return await task;
    } finally {
      this.pending.delete(task);
      if (!isConcurrent) {
        this.serial = undefined;
      }
    }
  }
}
