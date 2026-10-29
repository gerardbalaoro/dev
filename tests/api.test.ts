import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createGitRepo, createTempDir, writeConfig } from "@tests/helpers";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { Identity } from "@/process/identity";
import { Store } from "@/session/store";
import { Workspaces } from "@/workspace/resolve";

const Entry = path.resolve(process.env.DEV_TEST_API ?? "src/index.ts");
const Cli = path.resolve(process.env.DEV_TEST_CLI ?? "src/cli.ts");
const Tsx = import.meta.resolve("tsx");
const CliArgs = [...(Cli.endsWith(".ts") ? ["--import", Tsx] : []), Cli];

async function fixture(body: string, config = {}) {
  const root = await createGitRepo();
  const state = await createTempDir();
  await writeConfig(root, {
    hooks: { shutdown: "node shutdown.cjs" },
    name: "project",
    run: "node server.cjs",
    ...config,
  });
  await writeFile(path.join(root, "server.cjs"), "setInterval(() => {}, 1000)");
  await writeFile(
    path.join(root, "shutdown.cjs"),
    'require("node:fs").appendFileSync("stopped", "done\\n")'
  );
  const script = path.join(root, "script.mjs");
  await writeFile(
    script,
    `import { dev, Dev, port, env, docker } from ${JSON.stringify(Entry)};\n${body}`
  );
  const env = {
    DEV_STATE_DIR: state,
    TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
  };
  return {
    env,
    execute: (isInline = false) =>
      execa(
        process.execPath,
        [
          ...(Entry.endsWith(".ts") ? ["--import", Tsx] : []),
          ...(isInline
            ? ["--input-type=module", "--eval", `await import(${JSON.stringify(script)})`]
            : [script]),
        ],
        {
          cwd: root,
          env,
          timeout: 20_000,
        }
      ),
    root,
    state,
  };
}

describe("programmatic lifecycle", () => {
  it.each([
    { command: ["does-not-exist-dev-test"], error: "Unable to execute" },
    {
      command: [process.execPath, "-e", 'process.stdout.write("€".repeat(400000))'],
      error: "1 MiB",
    },
  ])(
    "rejects worker command failures and allows another execution: $error",
    async ({ command, error }) => {
      const f = await fixture(`
await dev.run(async session => {
  let failure;
  try { await session.exec(${JSON.stringify(command)}); }
  catch (error) { failure = error.message; }
  const next = await session.exec([process.execPath, "-p", "42"]);
  console.log(JSON.stringify({ failure, next }));
});
`);
      const result = await f.execute();
      const output = JSON.parse(result.stdout);
      expect(output.failure).toContain(error);
      expect(output.next).toStrictEqual({
        code: 0,
        stderr: "",
        stdout: "42\n",
      });
    },
    25_000
  );

  it.skipIf(process.platform === "win32").each(["stop", "exit"])(
    "waits for command termination before shutdown hooks on %s",
    async (ending) => {
      const f = await fixture(`
const { existsSync, writeFileSync } = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const session = await dev.start();
const task = session.exec([process.execPath, "command.cjs"]);
while (!existsSync("command.ready")) await delay(10);
if (${JSON.stringify(ending)} === "stop") await session.stop();
else { writeFileSync("exit", ""); await session.exited; }
console.log(JSON.stringify(await task));
`);
      await writeFile(
        path.join(f.root, "command.cjs"),
        `
const fs = require("node:fs");
process.once("SIGTERM", () => setTimeout(() => {
  fs.writeFileSync("command.stopped", "done");
  process.exit(0);
}, 250));
fs.writeFileSync("command.ready", "");
setInterval(() => {}, 1000);
`
      );
      await writeFile(
        path.join(f.root, "server.cjs"),
        `
setInterval(() => { if (require("node:fs").existsSync("exit")) process.exit(0); }, 10);
`
      );
      await writeFile(
        path.join(f.root, "shutdown.cjs"),
        `
const fs = require("node:fs");
if (fs.readFileSync("command.stopped", "utf8") !== "done") process.exit(9);
fs.writeFileSync("stopped", "after command");
`
      );
      const result = await f.execute();
      expect(JSON.parse(result.stdout).code).toBe(0);
      await expect(readFile(path.join(f.root, "stopped"), "utf-8")).resolves.toBe("after command");
    },
    25_000
  );

  it.skipIf(process.platform !== "linux").each([false, true])(
    "rejects pending work and recovers concurrent commands after owner death (retry: %s)",
    async (needsRetry) => {
      const f = await fixture(`
const { existsSync, writeFileSync } = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const session = await dev.start();
const results = Promise.allSettled([
  session.exited,
  session.exec([process.execPath, "command.cjs", "first"]),
  session.exec([process.execPath, "command.cjs", "second"]),
]);
while (!existsSync("first.pid") || !existsSync("second.pid")) await delay(10);
await session.exec([process.execPath, "-e", ""]);
writeFileSync("ready", "");
console.log(JSON.stringify((await results).map(result => ({
  status: result.status, message: result.reason?.message,
}))));
`);
      await writeFile(
        path.join(f.root, "command.cjs"),
        `
require("node:fs").writeFileSync(process.argv[2] + ".pid", String(process.pid));
setInterval(() => {}, 1000);
`
      );
      const store = new Store({ root: f.root }, f.state);
      const execution = f.execute();
      const completion = Promise.allSettled([execution]);
      const commands: Identity[] = [];
      let owner: Identity | undefined;
      let main: Identity | undefined;
      const stop = () =>
        execa(process.execPath, [...CliArgs, "stop"], {
          cwd: f.root,
          env: f.env,
          reject: false,
          timeout: 15_000,
        });
      try {
        await expect
          .poll(() => readFile(path.join(f.root, "ready"), "utf-8"), {
            timeout: 10_000,
          })
          .toBe("");
        const state = await store.read();
        if (!state) {
          throw new Error("Missing session state");
        }
        owner = { pid: state.pid, startToken: state.ownerStartToken };
        main = state.process;
        commands.push(
          ...(await Promise.all(
            ["first", "second"].map(async (name) => {
              const pid = Number(await readFile(path.join(f.root, `${name}.pid`), "utf-8"));
              return Identity.get(pid);
            })
          ))
        );
        const [first] = commands;
        if (!first) {
          throw new Error("Missing command identity");
        }
        process.kill(owner.pid, "SIGKILL");
        const output = await execution;
        const results = JSON.parse(output.stdout);
        expect(results).toHaveLength(3);
        for (const result of results) {
          expect(result.status).toBe("rejected");
          expect(result.message).toContain("Session owner exited unexpectedly");
        }
        const attempts = [];
        if (needsRetry) {
          await store.write({
            ...state,
            commands: state.commands?.map((command) =>
              command.pid === first.pid ? { pid: command.pid } : command
            ),
          });
          const failed = await stop();
          const retained = await store.read();
          const shutdown = await readFile(path.join(f.root, "stopped"), "utf-8").catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              return;
            }
            throw error;
          });
          attempts.push({
            code: failed.exitCode,
            commands: retained?.commands,
            shutdown,
          });
          if (!retained) {
            throw new Error("Recovery state was removed after failed cleanup");
          }
          await store.write({ ...retained, commands: [first] });
        }
        expect(attempts).toStrictEqual(
          needsRetry
            ? [
                {
                  code: 1,
                  commands: [{ pid: first.pid }],
                  shutdown: undefined,
                },
              ]
            : []
        );
        const stopped = await stop();
        expect(stopped.exitCode).toBe(0);
        await Promise.all(
          commands.map(async (command) => {
            await expect(Identity.matches(command)).resolves.toBeFalsy();
          })
        );
        await expect(store.read()).resolves.toBeUndefined();
        await expect(readFile(path.join(f.root, "stopped"), "utf-8")).resolves.toBe("done\n");
      } finally {
        if (owner && (await Identity.matches(owner))) {
          process.kill(owner.pid, "SIGKILL");
        }
        await Promise.all(commands.map((command) => Identity.stop(command)));
        if (main) {
          await Identity.stop(main);
        }
        execution.kill("SIGKILL");
        await completion;
      }
    },
    30_000
  );

  it("extends detected config and shares resolved values across exec calls", async () => {
    const f = await fixture(
      `
dev.env({ PORT: port.free(), COPY: env.get("PORT"), KEEP: "override" });
const session = await dev.start();
try {
  const first = await session.exec([process.execPath, "-e", "console.log(JSON.stringify({port:process.env.PORT,copy:process.env.COPY,keep:process.env.KEEP,base:process.env.BASE}))"]);
  const second = await session.exec([process.execPath, "-p", "process.env.PORT"]);
  console.log(JSON.stringify({ first: JSON.parse(first.stdout), second: second.stdout.trim(), workspace: session.workspace.name }));
} finally { await session.stop(); await session.stop(); }
`,
      { env: { BASE: "inherited", KEEP: "old" } }
    );
    const output = await f.execute();
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({
      first: { base: "inherited", keep: "override" },
      workspace: "project",
    });
    expect(Number(result.first.port)).toBeGreaterThan(0);
    expect(result.first.copy).toBe(result.first.port);
    expect(result.second).toBe(result.first.port);
    await expect(readFile(path.join(f.root, "stopped"), "utf-8")).resolves.toBe("done\n");
  }, 25_000);

  it("returns callback values only after cleanup and supports command overrides", async () => {
    const f = await fixture(
      `
const result = await dev.run("node server.cjs", async session => {
  const output = await session.exec([process.execPath, "-p", "'callback'"]);
  return output.stdout.trim();
});
const { readFile } = await import("node:fs/promises");
console.log(JSON.stringify({ result, stopped: await readFile("stopped", "utf-8") }));
`,
      { run: "exit 99" }
    );
    const output = await f.execute();
    expect(JSON.parse(output.stdout)).toStrictEqual({
      result: "callback",
      stopped: "done\n",
    });
  }, 25_000);

  it("cleans up after callback failure while preserving the original error", async () => {
    const f = await fixture(`
try { await dev.run(async () => { throw new Error("callback failed"); }); }
catch (error) { console.log(error.message); }
`);
    const output = await f.execute();
    expect(output.stdout).toBe("callback failed");
    await expect(readFile(path.join(f.root, "stopped"), "utf-8")).resolves.toBe("done\n");
  }, 25_000);

  it("waits for natural exit and cleanup without a callback", async () => {
    const f = await fixture(`
const result = await dev.run("exit 7");
const { readFile } = await import("node:fs/promises");
console.log(JSON.stringify({ code: result.code, stopped: await readFile("stopped", "utf-8") }));
`);
    const output = await f.execute();
    expect(JSON.parse(output.stdout)).toStrictEqual({
      code: 7,
      stopped: "done\n",
    });
  }, 25_000);

  it("allows external dev stop without terminating the embedding process", async () => {
    const f = await fixture(`
const session = await dev.start();
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
await promisify(execFile)(process.execPath, ${JSON.stringify([...CliArgs, "stop"])});
const result = await session.exited;
console.log(JSON.stringify({ code: result.code, survived: true }));
`);
    const output = await f.execute();
    expect(JSON.parse(output.stdout)).toStrictEqual({
      code: 143,
      survived: true,
    });
  }, 25_000);

  it("rejects startup and rolls back when bootstrap fails", async () => {
    const f = await fixture(
      `
try { await dev.start(); } catch(error) { console.log(error.message); }
`,
      { hooks: { bootstrap: "exit 8", shutdown: "node shutdown.cjs" } }
    );
    const output = await f.execute();
    expect(output.stdout).toContain("Bootstrap hook exited 8");
    await expect(readFile(path.join(f.root, "stopped"), "utf-8")).resolves.toBe("done\n");
  }, 25_000);

  it("rejects exited when shutdown fails rather than reporting successful completion", async () => {
    const f = await fixture(
      `
const session = await dev.start("exit 0");
try { await session.exited; } catch(error) { console.log(error.message); }
`,
      { hooks: { shutdown: "exit 4" } }
    );
    const output = await f.execute();
    expect(output.stdout).toContain("Cleanup failed");
  }, 25_000);

  it("preserves both callback and cleanup errors", async () => {
    const f = await fixture(
      `
try { await dev.run(async () => { throw new Error("callback failed"); }); }
catch (error) {
  console.log(JSON.stringify(error.errors.map(item => ({
    message: item.message,
    errors: item.errors?.map(failure => failure.message),
  }))));
}
`,
      { hooks: { shutdown: "exit 4" } }
    );
    const output = await f.execute();
    const errors = JSON.parse(output.stdout);
    expect(errors[0]).toStrictEqual({ message: "callback failed" });
    expect(errors[1]).toMatchObject({
      errors: ["Shutdown hook exited 4"],
      message: expect.stringContaining("Shutdown hook exited 4"),
    });
  }, 25_000);

  it("preserves stale cleanup details when a silent programmatic restart fails", async () => {
    const f = await fixture(
      `
try { await dev.run(); }
catch (error) {
  console.log(JSON.stringify({
    message: error.message,
    errors: error.errors?.map(failure => failure.message),
  }));
}
`,
      { hooks: { shutdown: "exit 4" }, run: "exit 0" }
    );
    await f.execute();
    const retried = await f.execute();
    expect(JSON.parse(retried.stdout)).toMatchObject({
      errors: ["Shutdown hook exited 4"],
      message: expect.stringContaining("Stale session cleanup failed"),
    });
    const state = await new Store(await Workspaces.git(f.root), f.state).read();
    expect(state?.shutdown).toBe("exit 4");
  }, 25_000);

  it("stops in-flight exec commands and refuses execution after shutdown", async () => {
    const f = await fixture(`
const session = await dev.start();
const task = session.exec([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
await session.exec([process.execPath, "-p", "'synchronized'"]);
await session.stop();
const result = await task;
try { await session.exec([process.execPath, "-e", "process.exit(0)"]); }
catch(error) { console.log(JSON.stringify({ code: result.code, error: error.message })); }
`);
    const output = await f.execute();
    expect(JSON.parse(output.stdout)).toStrictEqual({
      code: 143,
      error: "The session has stopped",
    });
  }, 25_000);

  it("cleans up when the embedding process exits without calling stop", async () => {
    const f = await fixture(`
await dev.start();
process.exit(0);
`);
    await f.execute();
    await expect
      .poll(() => readFile(path.join(f.root, "stopped"), "utf-8"), {
        timeout: 10_000,
      })
      .toBe("done\n");
  }, 25_000);

  it("builds independent instances without a config file and keeps overrides invocation-local", async () => {
    const f = await fixture(`
const { rm } = await import("node:fs/promises");
await rm("package.json");
const first = new Dev().name("first").extend({run: "exit 3"});
const override = await first.run("exit 7");
const original = await first.run();
const second = await new Dev().name("second").run("exit 5");
console.log(JSON.stringify([override.code, original.code, second.code]));
`);
    const output = await f.execute();
    expect(JSON.parse(output.stdout)).toStrictEqual([7, 3, 5]);
  }, 25_000);

  it("starts sessions from inline ESM scripts without inheriting entrypoint flags", async () => {
    const f = await fixture(`console.log((await dev.run("exit 7")).code);`);
    const output = await f.execute(true);
    expect(output.stdout).toBe("7");
  }, 25_000);
});
