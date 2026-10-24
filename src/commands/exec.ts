import { defineCommand } from "@crustjs/core";

import { context } from "@/context";
import { inherit } from "@/env/resolve";
import { run } from "@/process/run";
import { watch } from "@/process/signals";
import { Sessions } from "@/session/store";

async function exec(command: string[], cwd = process.cwd()): Promise<number> {
  if (!command.length) {
    throw new Error("Usage: dev exec <command...>");
  }
  const { git } = await context(cwd);
  const env = { ...inherit(), ...(await Sessions.env(git)) };
  const signals = watch();
  try {
    // Preserve argument boundaries; users can explicitly invoke sh -c for shell syntax.
    const result = await run(command, {
      cwd,
      env,
      shouldInherit: true,
      signal: signals.signal,
    });
    return result.code;
  } finally {
    signals.dispose();
  }
}

export default defineCommand(
  "exec",
  {
    description: "Run a command with the active session’s environment",
    sections: [
      {
        body: "A command is required. All arguments after exec, including --help, --version, and unknown flags, belong to the child command. An initial -- separator is optional. A running session is required.",
        title: "Argument forwarding",
      },
    ],
    usage: "dev exec <command...>",
  },
  (command) =>
    command.action(async ({ rawArgs }) => {
      process.exitCode = await exec(rawArgs);
    })
);
