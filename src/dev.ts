import path from "node:path";

import { merge } from "@/config/merge";
import type { Config, Extension } from "@/config/types";
import { connect } from "@/session/connect";
import type { Result, Running } from "@/session/launch";

type Callback<T> = (session: Running) => T | Promise<T>;

export class Dev {
  private readonly cwd: string;
  private config: Extension = {};

  constructor(cwd = process.cwd()) {
    this.cwd = path.resolve(cwd);
  }

  name(name: string): this {
    return this.extend({ name });
  }

  env(values: Config["env"]): this {
    return this.extend({ env: values });
  }

  endpoints(values: Config["endpoints"]): this {
    return this.extend({ endpoints: values });
  }

  hooks(values: Config["hooks"]): this {
    return this.extend({ hooks: values });
  }

  extend(config: Extension): this {
    this.config = structuredClone(merge(this.config, config));

    return this;
  }

  async start(command?: string): Promise<Running> {
    return await connect(this.cwd, structuredClone(merge(this.config, { run: command })));
  }

  run(command?: string): Promise<Result>;
  run<T>(action: Callback<T>): Promise<T>;
  run<T>(command: string, action: Callback<T>): Promise<T>;
  async run<T>(command?: string | Callback<T>, action?: Callback<T>): Promise<Result | T> {
    const workflow = typeof command === "function" ? command : action;
    const session = await this.start(typeof command === "string" ? command : undefined);

    if (!workflow) {
      return await session.exited;
    }

    let result: T;

    try {
      result = await workflow(session);
    } catch (primary) {
      try {
        await session.stop();
      } catch (error) {
        if (error === primary) {
          throw error;
        }

        throw new AggregateError([primary, error], "Callback failed and cleanup failed", {
          cause: error,
        });
      }

      throw primary;
    }

    await session.stop();

    return result;
  }
}

export const dev = new Dev();
