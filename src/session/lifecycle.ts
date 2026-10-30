import { randomUUID } from "node:crypto";

import { ResolvedEndpointSchema } from "@/config/schema";
import type { EndpointConfig } from "@/config/types";
import { hostname } from "@/endpoints/hostname";
import type { Endpoints } from "@/endpoints/types";
import { inherit } from "@/env/resolve";
import { foreground } from "@/process/foreground";
import { Identity } from "@/process/identity";
import type { RunOptions } from "@/process/run";
import { restore } from "@/proxy/detect";
import { Routes } from "@/proxy/routes";
import type { Provider } from "@/proxy/types";
import { Execution } from "@/session/execution";
import { SessionSchema } from "@/session/schema";
import type { Store } from "@/session/store";
import type { Session } from "@/session/types";
import type { UI } from "@/ui/index";
import type { Workspace } from "@/workspace/resolve";

// The workspace lock belongs to the caller; this module owns every journal transition.
export class Journal {
  private readonly routes: Routes;
  private state: Session;
  private readonly store: Store;
  private isPrepared = false;
  private writing = Promise.resolve<null>(null);

  constructor(state: Session, store: Store) {
    this.state = SessionSchema.parse(state);
    this.store = store;
    this.routes = new Routes(store.routesDirectory);
  }

  static async create(workspace: Workspace, store: Store): Promise<Journal> {
    const owner = await Identity.get(process.pid);
    if (!(owner.startToken ?? "")) {
      throw new Error("Cannot establish the session owner's process identity");
    }
    const session: Session = {
      endpoints: {},
      env: {
        COMPOSE_PROJECT_NAME: workspace.name,
        WORKSPACE_NAME: workspace.name,
      },
      id: randomUUID(),
      ownerStartToken: owner.startToken,
      pendingRoutes: [],
      pid: owner.pid,
      root: workspace.root,
      startedAt: new Date().toISOString(),
      status: "starting",
      version: 1,
      workspace: workspace.name,
    };
    await store.write(session);
    return new Journal(session, store);
  }

  private async commit(update: (state: Session) => Session): Promise<void> {
    const previous = this.writing;
    const completion = Promise.withResolvers<null>();
    this.writing = completion.promise;
    await previous;
    try {
      const validated = SessionSchema.parse(update(this.state));
      await this.store.write(validated);
      this.state = validated;
    } finally {
      completion.resolve(null);
    }
  }

  async reserve(endpoints: Record<string, EndpointConfig>, shutdown?: string): Promise<void> {
    const pendingRoutes = Object.entries(endpoints).map(([name, definition]) => ({
      hostname: hostname(name, this.state.workspace, ResolvedEndpointSchema.parse(definition).root),
      owner: this.state.id,
      root: this.state.root,
    }));
    await this.commit((state) => ({ ...state, pendingRoutes }));
    await Array.fromAsync(pendingRoutes, async (claim) => {
      await this.routes.reserve(claim);
    });
    // Arm rollback only after claims succeed, before any bootstrap side effects.
    await this.commit((state) => ({ ...state, shutdown }));
  }

  observe(): Pick<RunOptions, "onSpawn" | "onSettled"> {
    return {
      onSettled: async () => {
        await this.commit((state) => ({ ...state, process: undefined }));
      },
      onSpawn: async (pid, groupToken) => {
        if (this.state.process) {
          throw new Error("A managed process is already active in this session");
        }
        const identity = await Identity.get(pid);
        await this.commit((state) => ({
          ...state,
          process: { ...identity, groupToken },
        }));
      },
    };
  }

  observeCommand(): Pick<RunOptions, "onSpawn" | "onSettled"> {
    let token: string | undefined;
    return {
      onSettled: async () => {
        if (token !== undefined && token !== "") {
          await this.commit((state) => ({
            ...state,
            commands: state.commands?.filter((command) => command.groupToken !== token),
          }));
        }
      },
      onSpawn: async (pid, groupToken) => {
        const identity = await Identity.get(pid);
        await this.commit((state) => ({
          ...state,
          commands: [...(state.commands ?? []), { ...identity, groupToken }],
        }));
        token = groupToken;
      },
    };
  }

  async prepare(
    endpoints: Endpoints,
    env: Record<string, string>,
    provider?: Provider
  ): Promise<void> {
    if (this.state.status !== "starting") {
      throw new Error("Only a starting session can prepare routes");
    }
    if (Object.keys(endpoints).length && !provider) {
      throw new Error("Endpoints require a prepared proxy");
    }
    await this.commit((state) => ({
      ...state,
      endpoints,
      env: { ...state.env, ...env },
      proxy: provider?.getState(),
    }));
    this.isPrepared = true;
  }

  async activate(provider: Provider | undefined, signal: AbortSignal): Promise<void> {
    if (this.state.status !== "starting" || !this.isPrepared) {
      throw new Error("Only a prepared starting session can be activated");
    }
    await Array.fromAsync(this.state.pendingRoutes, async (claim) => {
      signal.throwIfAborted();
      if (!provider) {
        throw new Error("Endpoints require a prepared proxy");
      }
      const endpoint = Object.values(this.state.endpoints).find(
        (entry) => entry.hostname === claim.hostname
      );
      if (!endpoint) {
        throw new Error(`No resolved endpoint for ${claim.hostname}`);
      }
      await this.routes.publish({ ...claim, port: endpoint.port }, provider);
    });
    signal.throwIfAborted();
    await this.commit((state) => ({ ...state, status: "running" }));
  }

  async cleanup(ui: UI): Promise<AggregateError | undefined> {
    const errors: Error[] = [];
    const failure = () =>
      new AggregateError(
        errors,
        errors.map((error) => `Cleanup failed: ${error.message}`).join("\n")
      );
    const attempt = async (action: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        errors.push(cause);
        ui.error(`Cleanup failed: ${cause.message}`);
        return false;
      }
    };
    if (
      !(await attempt(async () => {
        const owner = await Identity.get(process.pid);
        if (!(owner.startToken ?? "")) {
          throw new Error("Cannot establish the cleanup owner's process identity");
        }
        await this.commit((state) => ({
          ...state,
          ownerStartToken: owner.startToken,
          pid: owner.pid,
          status: "stopping",
        }));
      }))
    ) {
      return failure();
    }

    const tracked = this.state.process;
    if (tracked) {
      await attempt(async () => {
        await Identity.stop(tracked);
        await this.commit((state) => ({ ...state, process: undefined }));
      });
    }
    await Array.fromAsync(this.state.commands ?? [], async (command) => {
      await attempt(async () => {
        await Identity.stop(command);
        await this.commit((state) => ({
          ...state,
          commands: state.commands?.filter((pending) => pending.pid !== command.pid),
        }));
      });
    });
    if ((this.state.commands?.length ?? 0) > 0) {
      return failure();
    }
    {
      const provider = this.state.proxy
        ? restore(this.state.proxy, this.state.root, {
            ...inherit(),
            ...this.state.env,
          })
        : undefined;
      await Array.fromAsync(this.state.pendingRoutes, async (claim) => {
        await attempt(async () => {
          await this.routes.remove(claim, provider);
          await this.commit((state) => ({
            ...state,
            pendingRoutes: state.pendingRoutes.filter(
              (pending) => pending.hostname !== claim.hostname
            ),
          }));
        });
      });
    }
    const { shutdown } = this.state;
    if (shutdown !== undefined && shutdown !== "" && !this.state.process) {
      await attempt(async () => {
        // Shutdown must still run after live session execution has stopped.
        const execution = new Execution(this, AbortSignal.timeout(30_000));
        const code = await foreground(
          shutdown,
          {
            cwd: this.state.root,
            env: { ...inherit(), ...this.state.env },
          },
          ui,
          true,
          execution.run
        );
        if (code) {
          throw new Error(`Shutdown hook exited ${code}`);
        }
        await this.commit((state) => ({ ...state, shutdown: undefined }));
      });
    }
    if (
      errors.length === 0 &&
      !this.state.process &&
      !(this.state.shutdown ?? "") &&
      !this.state.pendingRoutes.length
    ) {
      await attempt(async () => {
        await this.store.remove(this.state.id);
      });
    }
    return errors.length ? failure() : undefined;
  }
}
