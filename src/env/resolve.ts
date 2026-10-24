import { z } from "zod";

import { interpolate } from "@/env/interpolate";
import { command } from "@/env/resolvers/command";
import { published } from "@/env/resolvers/docker-compose";
import { read } from "@/env/resolvers/env";
import { allocator } from "@/env/resolvers/port";
import type { Allocator } from "@/env/resolvers/port";
import { NameSchema, ServiceSchema, PortSchema } from "@/env/schema";
import type { RunOptions } from "@/process/run";

const ComposePortSchema = z.tuple([ServiceSchema, PortSchema]);
const CommandSchema = z.tuple([
  z.string().refine((script) => script.trim().length > 0),
]);
const EnvSchema = z.tuple([NameSchema]);
const FreePortSchema = z.tuple([]);

export function inherit(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}

interface ResolverOptions {
  allocator?: Allocator;
  signal?: AbortSignal;
  observer?: Pick<RunOptions, "onSpawn" | "onSettled">;
}

export class Resolver {
  private readonly options: ResolverOptions;

  readonly cwd: string;

  private readonly allocator: Allocator;
  readonly env: Record<string, string>;
  readonly resolved: Record<string, string> = Object.create(null);
  constructor(
    base: Record<string, string>,
    cwd: string,
    options: ResolverOptions = {}
  ) {
    this.options = options;

    this.cwd = cwd;

    this.allocator = options.allocator ?? allocator();
    this.env = Object.assign(Object.create(null), base);
  }

  set(name: string, value: string): void {
    this.env[name] = value;
    this.resolved[name] = value;
  }

  async resolveValue(expression: string): Promise<string> {
    this.options.signal?.throwIfAborted();
    return await interpolate(expression, {
      "docker.compose.port": (...args) => {
        const [service, port] = ComposePortSchema.parse(args);
        return published(service, port, {
          cwd: this.cwd,
          env: this.env,
          signal: this.options.signal,
          ...this.options.observer,
        });
      },
      env: (...args) => {
        const [name] = EnvSchema.parse(args);
        return read(name, this.env);
      },
      exec: (...args) => {
        const [script] = CommandSchema.parse(args);
        return command(
          script,
          this.env,
          this.cwd,
          this.options.signal,
          this.options.observer
        );
      },
      port: async (...args) => {
        FreePortSchema.parse(args);
        return String(await this.allocator.allocate());
      },
    });
  }

  async resolve(values: Record<string, string>): Promise<void> {
    await Array.fromAsync(
      Object.entries(values),
      async ([name, expression]) => {
        this.set(name, await this.resolveValue(expression));
      }
    );
  }
}
