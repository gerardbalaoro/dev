import path from "node:path";

import { createGitRepo, createTempDir, writeConfig } from "@tests/helpers";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const Cli = path.resolve(process.env.DEV_TEST_CLI ?? "src/cli.ts");
const Tsx = import.meta.resolve("tsx");
const CliArgs = [...(Cli.endsWith(".ts") ? ["--import", Tsx] : []), Cli];

async function invoke(args: string[], cwd: string) {
  return await execa(process.execPath, [...CliArgs, ...args], {
    cwd,
    env: {
      DEV_STATE_DIR: await createTempDir(),
      NO_COLOR: "1",
      TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
    },
    reject: false,
  });
}

describe("cli", () => {
  it.each([{ args: [] }, { args: ["--help"] }, { args: ["-h"] }])(
    "shows available commands outside a Git workspace for $args",
    async ({ args }) => {
      const result = await invoke(args, await createTempDir());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dev <command>");
      for (const command of ["start", "stop", "status", "exec"]) {
        expect(result.stdout).toContain(command);
      }
      expect(result.stdout).toContain("https://github.com/gerardbalaoro/dev");
      expect(result.stderr).toBe("");
    }
  );

  it.each(["--version", "-v"])(
    "reports the package version without loading a workspace for %s",
    async (flag) => {
      const result = await invoke([flag], await createTempDir());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^dev v\d+\.\d+\.\d+$/u);
      expect(result.stderr).toBe("");
    }
  );

  it.each(["start", "stop", "status"])(
    "shows %s help without running the command",
    async (command) => {
      const result = await invoke([command, "--help"], await createTempDir());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`dev ${command}`);
      expect(result.stderr).toBe("");
    }
  );

  it.each([
    { args: ["unknown"], error: "Unknown command" },
    { args: ["--unknown"], error: "Unknown flag" },
    { args: ["start", "--unknown"], error: "Unknown flag" },
    { args: ["exec"], error: "Usage: dev exec <command...>" },
    { args: ["exec", "--"], error: "Usage: dev exec <command...>" },
    { args: ["exec", "--help"], error: "No active dev session" },
    { args: ["exec", "--version"], error: "No active dev session" },
  ])("rejects $args with a nonzero exit status", async ({ args, error }) => {
    const root = await createGitRepo();
    await writeConfig(root, { name: "project", run: "node app.cjs" });
    const result = await invoke(args, root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.stdout).toBe("");
  });
});
