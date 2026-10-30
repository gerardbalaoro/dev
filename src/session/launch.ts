/* oxlint-disable typescript/promise-function-async -- Stop returns the stable completion promise without wrapping it. */
import { load } from "@/config/load";
import type { Extension } from "@/config/types";
import { context } from "@/context";
import { Endpoints } from "@/endpoints/resolve";
import type { Endpoints as ResolvedEndpoints } from "@/endpoints/types";
import { inherit, Resolver } from "@/env/resolve";
import { foreground } from "@/process/foreground";
import type { ProcessResult } from "@/process/run";
import { detect } from "@/proxy/detect";
import { Execution } from "@/session/execution";
import { Journal } from "@/session/lifecycle";
import { acquire, running } from "@/session/lock";
import { Sessions } from "@/session/store";
import type { UI } from "@/ui/index";
import { Workspaces } from "@/workspace/resolve";
import type { Workspace } from "@/workspace/resolve";

export interface Result {
  code: number;
}

export interface Running {
  readonly workspace: Workspace;
  readonly endpoints: ResolvedEndpoints;
  readonly env: Record<string, string>;
  readonly exited: Promise<Result>;
  exec: (command: string[]) => Promise<ProcessResult>;
  stop: () => Promise<Result>;
}

export async function launch(
  cwd: string,
  extension: Extension,
  ui: UI,
  signal?: AbortSignal
): Promise<Running> {
  const { git, store } = await context(cwd);
  const config = await load(git.root, extension);
  const workspace = Workspaces.name(config.name, git);
  let release: (() => Promise<void>) | undefined;
  let journal: Journal | undefined;
  let execution: Execution | undefined;
  let closing: Promise<void> | undefined;

  function cleanup(): Promise<void> {
    closing ??= (async () => {
      await execution?.stop();

      try {
        const failure = await journal?.cleanup(ui);

        if (failure) {
          throw failure;
        }
      } finally {
        await release?.();
      }
    })();

    return closing;
  }

  async function rollback(primary: Error): Promise<never> {
    try {
      await cleanup();
    } catch (error) {
      throw new AggregateError([primary, error], "Session failed and cleanup failed", {
        cause: error,
      });
    }

    throw primary;
  }

  try {
    release = await acquire(store);
    signal?.throwIfAborted();
    const existing = await store.read();

    if (existing) {
      if (await Sessions.alive(existing)) {
        throw running(existing.workspace, existing.pid);
      }

      ui.info("Cleaning up the previous session");
      const failure = await new Journal(existing, store).cleanup(ui);

      if (failure) {
        throw new AggregateError(
          failure.errors,
          `Stale session cleanup failed: ${failure.message}`
        );
      }
    }

    const base = {
      ...inherit(),
      COMPOSE_PROJECT_NAME: workspace.name,
      WORKSPACE_NAME: workspace.name,
    };

    const active = await Journal.create(workspace, store);
    journal = active;
    const processes = new Execution(active, signal);
    execution = processes;
    const cancellation = processes.signal;
    await journal.reserve(config.endpoints, config.hooks.shutdown);
    ui.start(workspace.name);

    if (config.hooks.bootstrap !== undefined && config.hooks.bootstrap !== "") {
      const code = await foreground(
        config.hooks.bootstrap,
        { cwd: workspace.root, env: base },
        ui,
        true,
        processes.run
      );

      if (code) {
        throw new Error(`Bootstrap hook exited ${code}`);
      }
    }

    const resolver = new Resolver(base, workspace.root, {
      execute: processes.run,
      signal: cancellation,
    });

    const ports = await Endpoints.ports(config.endpoints, workspace.name, resolver);

    const proxy = Object.keys(ports).length
      ? await detect(workspace.root, {
          applicationPorts: Object.values(ports).map((endpoint) => endpoint.port),
          env: resolver.env,
          signal: cancellation,
        })
      : undefined;

    const endpoints = proxy ? await Endpoints.urls(ports, proxy, resolver) : {};
    await resolver.resolve(config.env);
    await journal.prepare(endpoints, resolver.resolved, proxy);
    await journal.activate(proxy, cancellation);
    ui.showEndpoints(endpoints);

    const application = await processes.start(
      config.run,
      {
        cwd: workspace.root,
        env: resolver.env,
      },
      ui
    );

    const exited = application.exited.then(async (code) => {
      await cleanup();

      return { code };
    }, rollback);

    // A session may fail before its caller starts observing completion.
    void exited.catch(() => {
      // The original promise remains rejected for the caller to observe.
    });

    return {
      endpoints,
      env: { ...base, ...resolver.resolved },
      async exec(command) {
        return await processes.exec(command, {
          cwd: workspace.root,
          env: resolver.env,
        });
      },
      exited,
      stop() {
        void processes.stop();

        return exited;
      },
      workspace,
    };
  } catch (error) {
    if (closing) {
      throw error;
    }

    return await rollback(error instanceof Error ? error : new Error(String(error)));
  }
}
