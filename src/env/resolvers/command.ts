import { run } from "@/process/run";
import type { RunOptions } from "@/process/run";

export async function command(
  script: string,
  env: Record<string, string>,
  cwd: string,
  signal?: AbortSignal,
  observer: Pick<RunOptions, "onSpawn" | "onSettled"> = {}
): Promise<string> {
  const result = await run(script, {
    cwd,
    env,
    shouldCapture: true,
    signal,
    ...observer,
  });
  if (result.code !== 0) {
    throw new Error(`Command expression failed (exit ${result.code}): ${script}\n${result.stderr}`);
  }
  return result.stdout.trim();
}
