import { run } from "@/process/run";
import type { ExecutionOptions, Executor } from "@/process/run";
import type { UI } from "@/ui/index";

export async function foreground(
  command: string,
  options: ExecutionOptions,
  ui: UI,
  isHook = false,
  execute: Executor = run
): Promise<number> {
  const output = ui.output(command, isHook ? 8 : 12);
  try {
    const result = await execute(command, {
      ...options,
      onOutput: (chunk) => {
        output.write(chunk);
      },
    });
    output.finish(result.code);
    return result.code;
  } catch (error) {
    output.finish(1);
    throw error;
  }
}
