import { z } from "zod";

import { run } from "@/process/run";
import type { RunOptions } from "@/process/run";

const ContainerSchema = z.object({
  Publishers: z
    .array(
      z.object({
        Protocol: z.string(),
        PublishedPort: z.number().int().min(0).max(65_535),
        TargetPort: z.number(),
      })
    )
    .nullish(),
});

export async function published(
  service: string,
  containerPort: number,
  options: RunOptions
): Promise<string> {
  const timeout = AbortSignal.timeout(15_000);
  const result = await run(
    ["docker", "compose", "ps", "--format", "json", "--status", "running", service],
    {
      ...options,
      shouldCapture: true,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    }
  );
  if (result.code !== 0) {
    throw new Error(
      `Docker Compose port lookup failed for ${service}:${containerPort}: ${result.stderr.trim()}`
    );
  }

  const publishers = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => ContainerSchema.parse(JSON.parse(line)).Publishers ?? []);
  const ports = new Set(
    publishers
      .filter(
        (binding) =>
          binding.TargetPort === containerPort &&
          binding.Protocol === "tcp" &&
          binding.PublishedPort > 0
      )
      .map((binding) => binding.PublishedPort)
  );
  if (ports.size !== 1) {
    throw new Error(
      `Expected one published TCP port for ${service}:${containerPort}, found ${ports.size}`
    );
  }
  return String([...ports][0]);
}
