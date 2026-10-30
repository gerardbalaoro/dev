import { run } from "@/process/run";
import type { ExecutionOptions, Executor } from "@/process/run";

export async function command(
  script: string,
  options: ExecutionOptions,
  execute: Executor = run
): Promise<string> {
  const result = await execute(script, {
    ...options,
    shouldCapture: true,
  });

  if (result.code !== 0) {
    throw new Error(`Command expression failed (exit ${result.code}): ${script}\n${result.stderr}`);
  }

  return result.stdout.trim();
}
