import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createTempDir } from "@tests/helpers";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { inherit } from "@/env/resolve";
import { Identity } from "@/process/identity";
import { run } from "@/process/run";

describe("process", () => {
  it.skipIf(process.platform === "win32")(
    "uses creation time rather than PID alone in the macOS identity path",
    async () => {
      const { stdout } = await execa(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { Identity } = await import("./src/process/identity.ts");
      const identity = await Identity.get(process.pid);
      console.log(JSON.stringify({
        hasToken: Boolean(identity.startToken),
        matchesSelf: await Identity.matches(identity),
        matchesStale: await Identity.matches({ ...identity, startToken: "old-process" }),
      }));
    `,
      ]);
      expect(JSON.parse(stdout)).toStrictEqual({
        hasToken: true,
        matchesSelf: true,
        matchesStale: false,
      });
    }
  );

  it("refuses to identify a live process from a PID alone", async () => {
    await expect(Identity.matches({ pid: process.pid })).rejects.toThrow("verify");
  });

  it.skipIf(process.platform !== "linux")(
    "recovers a managed process group after its leader has disappeared",
    async () => {
      const root = await createTempDir();
      const groupToken = randomUUID();
      const leader = spawn("/bin/sh", ["-c", "sleep 120 & echo $! > child.pid; wait"], {
        cwd: root,
        detached: true,
        env: { ...process.env, DEV_PROCESS_TOKEN: groupToken },
        stdio: "ignore",
      });
      assert.ok(leader.pid);
      const { pid } = leader;
      try {
        await expect.poll(() => readFile(path.join(root, "child.pid"), "utf-8")).toMatch(/^\d+/u);
        const descendant = Number(await readFile(path.join(root, "child.pid"), "utf-8"));
        const identity = { ...(await Identity.get(pid)), groupToken };
        const exited = once(leader, "exit");
        leader.kill("SIGKILL");
        await exited;
        await Identity.stop(identity);
        await expect
          .poll(async () => {
            const current = await Identity.get(descendant);
            return current.startToken;
          })
          .toBeUndefined();
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already reaped */
        }
      }
    },
    10_000
  );

  it.each([
    'process.stdout.write("x".repeat(2*1024*1024))',
    'process.stdout.write("€".repeat(400000))',
    'process.stdout.write("€".repeat(200000)); process.stderr.write("€".repeat(200000))',
  ])("bounds captured stdout and stderr in bytes: %s", async (script) => {
    await expect(
      run([process.execPath, "-e", script], {
        cwd: await createTempDir(),
        env: inherit(),
        shouldCapture: true,
      })
    ).rejects.toThrow("1 MiB");
  });

  it("preserves multibyte output exactly at the capture limit", async () => {
    const result = await run(
      [process.execPath, "-e", 'process.stdout.write("€".repeat(349525) + "x")'],
      { cwd: await createTempDir(), env: inherit(), shouldCapture: true }
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${"€".repeat(349_525)}x`);
    expect(result.stderr).toBe("");
  });

  it("terminates descendants that retain stdout after the shell exits", async () => {
    const output: string[] = [];
    const before = Date.now();
    const result = await run("sleep 60 & printf done; exit 4", {
      cwd: await createTempDir(),
      env: inherit(),
      onOutput: (chunk) => output.push(chunk),
    });
    expect(result.code).toBe(4);
    expect(output.join("")).toBe("done");
    expect(Date.now() - before).toBeLessThan(5000);
  }, 7000);

  it("preserves exit codes from signal-terminated commands", async () => {
    const result = await run("kill -KILL $$", {
      cwd: await createTempDir(),
      env: inherit(),
    });
    expect(result.code).toBe(137);
  });

  it("reports missing executables and does not start aborted commands", async () => {
    const options = { cwd: await createTempDir(), env: inherit() };
    await expect(run(["does-not-exist-dev-test"], options)).rejects.toThrow("Unable to execute");
    await expect(run("echo never", { ...options, signal: AbortSignal.abort() })).rejects.toThrow(
      "aborted"
    );
  });
});
