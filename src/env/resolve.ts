import { z } from "zod";

import { interpolate } from "@/env/interpolate";
import { command } from "@/env/resolvers/command";
import { published } from "@/env/resolvers/docker-compose";
import { read } from "@/env/resolvers/env";
import { allocator } from "@/env/resolvers/port";
import type { Allocator } from "@/env/resolvers/port";
import { NameSchema, ServiceSchema, PortSchema } from "@/env/schema";
import type { Executor } from "@/process/run";

const ComposePortSchema = z.tuple([ServiceSchema, PortSchema]);
const CommandSchema = z.tuple([z.string().refine((script) => script.trim().length > 0)]);
const EnvSchema = z.tuple([NameSchema]);
const FreePortSchema = z.tuple([]);

export function inherit(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

interface ResolverOptions {
  allocator?: Allocator;
  signal?: AbortSignal;
  execute?: Executor;
}

export class Resolver {
  private readonly options: ResolverOptions;

  readonly cwd: string;

  private readonly allocator: Allocator;
  readonly env: Record<string, string>;
  readonly resolved: Record<string, string> = {};
  constructor(base: Record<string, string>, cwd: string, options: ResolverOptions = {}) {
    this.options = options;

    this.cwd = cwd;

    this.allocator = options.allocator ?? allocator();
    this.env = { ...base };
    Object.setPrototypeOf(this.env, null);
    Object.setPrototypeOf(this.resolved, null);
  }

  set(name: string, value: string): void {
    this.env[name] = value;
    this.resolved[name] = value;
  }

  async resolveValue(expression: string): Promise<string> {
    this.options.signal?.throwIfAborted();

    return await interpolate(expression, {
      "docker.compose.port": async (...args) => {
        const [service, port] = ComposePortSchema.parse(args);

        return await published(
          service,
          port,
          { cwd: this.cwd, env: this.env, signal: this.options.signal },
          this.options.execute
        );
      },
      env: (...args) => {
        const [name] = EnvSchema.parse(args);

        return read(name, this.env);
      },
      exec: async (...args) => {
        const [script] = CommandSchema.parse(args);

        return await command(
          script,
          { cwd: this.cwd, env: this.env, signal: this.options.signal },
          this.options.execute
        );
      },
      port: async (...args) => {
        FreePortSchema.parse(args);

        return String(await this.allocator.allocate());
      },
    });
  }

  async resolve(values: Record<string, string>): Promise<void> {
    await Array.fromAsync(Object.entries(values), async ([name, expression]) => {
      this.set(name, await this.resolveValue(expression));
    });
  }
}
