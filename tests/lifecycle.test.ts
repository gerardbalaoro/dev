import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setInterval as interval } from "node:timers/promises";

import { writeConfig, createGitRepo, createTempDir } from "@tests/helpers";
import { createCaddy } from "@tests/proxy/caddy-fixture";
import { execa } from "execa";
import { describe, afterEach, expect, it } from "vitest";
import { z } from "zod";

import type { Config } from "@/config/types";
import { Identity } from "@/process/identity";
import { Store } from "@/session/store";
import { Workspaces } from "@/workspace/resolve";

async function waitUntil(check: () => Promise<boolean>, diagnostic = () => "", timeout = 10_000) {
  if (await check()) {
    return;
  }

  for await (const deadline of interval(50, Date.now() + timeout)) {
    if (Date.now() >= deadline) {
      break;
    }

    if (await check()) {
      return;
    }
  }

  throw new Error(`Timed out: ${diagnostic()}`);
}

describe("lifecycle", () => {
  const cli = path.resolve(process.env.DEV_TEST_CLI ?? "src/cli.ts");
  const tsx = import.meta.resolve("tsx");
  const children: ChildProcess[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    }

    await Promise.all(
      cleanups.splice(0).map(async (fn) => {
        await fn();
      })
    );
  });

  function launch(root: string, env: NodeJS.ProcessEnv, args: string[]) {
    const child = spawn(process.execPath, ["--import", tsx, cli, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    const done = (async () => {
      await once(child, "close");

      return { code: child.exitCode, output };
    })();

    return { child, done, output: () => output };
  }

  async function createFixture(extra: Partial<Config> = {}) {
    const root = await createGitRepo();
    const state = await createTempDir();
    const bin = path.join(await createTempDir(), "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "portless"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    await writeFile(path.join(bin, "caddy"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const proxy = await createCaddy();
    cleanups.push(proxy.close);

    const env = {
      ...process.env,
      CADDY_ADMIN: proxy.admin,
      DEV_STATE_DIR: state,
      NO_COLOR: "1",
      PATH: `${bin}:${process.env.PATH}`,
      TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
    };

    await writeFile(
      path.join(root, "hook.cjs"),
      `const { appendFileSync } = require("node:fs");
const entry = {
  stage: process.argv[2],
  workspace: process.env.WORKSPACE_NAME,
  compose: process.env.COMPOSE_PROJECT_NAME,
  port: process.env.WEB_PORT,
};
appendFileSync("hooks.jsonl", JSON.stringify(entry) + "\\n");`
    );
    await writeFile(
      path.join(root, "run.cjs"),
      `const { createServer } = require("node:http");
createServer((_request, response) => response.end(process.env.MESSAGE))
  .listen(Number(process.env.WEB_PORT), "127.0.0.1");`
    );
    await writeConfig(root, {
      endpoints: { web: { port: `\${port()}`, root: true } },
      env: {
        FROM_URL: `\${env('WEB_URL')}`,
        MESSAGE: `hello-\${env('WEB_PORT')}`,
      },
      hooks: {
        bootstrap: "node hook.cjs bootstrap",
        shutdown: "node hook.cjs shutdown",
      },
      name: "project",
      run: "node run.cjs",
      ...extra,
    });
    const store = new Store(await Workspaces.resolve("project", root), state);

    return { env, proxy, root, state, store };
  }

  it("starts, rejects duplicates, reuses exact values for exec, and reports status", async () => {
    const f = await createFixture();
    const owner = launch(f.root, f.env, ["start"]);
    await waitUntil(async () => {
      const session = await f.store.read();

      return session?.status === "running";
    }, owner.output);
    const session = await f.store.read();
    assert.ok(session);
    await waitUntil(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${session.env.WEB_PORT}`);

        return response.ok;
      } catch {
        return false;
      }
    });
    const response2 = await fetch(`http://127.0.0.1:${session.env.WEB_PORT}`);
    await expect(response2.text()).resolves.toBe(session.env.MESSAGE);
    const duplicate = await launch(f.root, f.env, ["start"]).done;
    const expectedOutput: unknown = expect.stringContaining("already running");
    expect(duplicate).toMatchObject({
      code: 1,
      output: expectedOutput,
    });
    const info = await launch(f.root, f.env, ["status"]).done;
    expect(info.output).toContain("running");
    expect(info.output).toContain(session.env.WEB_URL);
    await Promise.all(
      [[], ["--"]].map(async (separator) => {
        const executed = await launch(f.root, f.env, [
          "exec",
          ...separator,
          "node",
          "-e",
          "console.log(JSON.stringify({port:process.env.WEB_PORT,url:process.env.FROM_URL,args:process.argv.slice(1)}));process.exit(7)",
          "space value",
          "",
          "--help",
          "--version",
          "--unknown=value",
          "--",
          "-x",
        ]).done;

        expect({
          code: executed.code,
          env: z.json().parse(JSON.parse(executed.output)),
        }).toStrictEqual({
          code: 7,
          env: {
            args: ["space value", "", "--help", "--version", "--unknown=value", "--", "-x"],
            port: session.env.WEB_PORT,
            url: session.env.WEB_URL,
          },
        });
      })
    );
    await launch(f.root, f.env, ["stop"]).done;
    await owner.done;
  }, 25_000);

  it("stops the owner, removes routes and state, and preserves hook environment", async () => {
    const f = await createFixture();
    const owner = launch(f.root, f.env, ["start"]);
    await waitUntil(async () => {
      const current = await f.store.read();

      return current?.status === "running";
    }, owner.output);
    const session = await f.store.read();
    assert.ok(session);
    const stopped = await launch(f.root, f.env, ["stop"]).done;
    const exited = await owner.done;
    expect({
      ownerCode: exited.code,
      routes: f.proxy.routes,
      session: await f.store.read(),
      stopCode: stopped.code,
    }).toStrictEqual({
      ownerCode: 143,
      routes: [],
      session: undefined,
      stopCode: 0,
    });
    const contents = await readFile(path.join(f.root, "hooks.jsonl"), "utf-8");

    const hooks = contents
      .trim()
      .split("\n")
      .map((line) => z.record(z.string(), z.string()).parse(JSON.parse(line)));

    expect(hooks).toStrictEqual([
      { compose: "project", stage: "bootstrap", workspace: "project" },
      {
        compose: "project",
        port: session.env.WEB_PORT,
        stage: "shutdown",
        workspace: "project",
      },
    ]);
    const result = await launch(f.root, f.env, ["exec", "node", "-e", "process.exit(0)"]).done;
    expect(result.output).toContain("Run `dev start` first");
  }, 25_000);

  it("returns the run exit code and executes cleanup on natural exit", async () => {
    const f = await createFixture({ run: "exit 9" });
    const started = await launch(f.root, f.env, ["start"]).done;
    expect(started.code).toBe(9);
    await expect(f.store.read()).resolves.toBeUndefined();
    expect(f.proxy.routes).toHaveLength(0);
    await expect(readFile(path.join(f.root, "hooks.jsonl"), "utf-8")).resolves.toContain(
      "shutdown"
    );
  });

  it("rejects a second clone claiming the same hostname without removing the first route", async () => {
    const first = await createFixture();
    const second = await createFixture({ run: "exit 0" });
    const owner = launch(first.root, first.env, ["start"]);
    await waitUntil(async () => {
      const current = await first.store.read();

      return current?.status === "running";
    }, owner.output);
    const route = structuredClone(first.proxy.routes);
    const collision = await launch(second.root, first.env, ["start"]).done;
    expect(collision.code).toBe(1);
    expect(collision.output).toContain("already claimed");
    expect(first.proxy.routes).toStrictEqual(route);
    await expect(readFile(path.join(second.root, "hooks.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await launch(first.root, first.env, ["stop"]).done;
    await owner.done;
  }, 15_000);

  it("runs an endpoint-free worker without requiring a proxy", async () => {
    const fixture = await createFixture({
      endpoints: {},
      env: {},
      hooks: {},
      run: "printf worker-output",
    });

    const result = await launch(
      fixture.root,
      { ...fixture.env, CADDY_ADMIN: "http://127.0.0.1:1" },
      ["start"]
    ).done;

    const expectedOutput: unknown = expect.stringContaining("worker-output");
    expect(result).toMatchObject({
      code: 0,
      output: expectedOutput,
    });
    expect(fixture.proxy.calls).toHaveLength(0);
    await expect(fixture.store.read()).resolves.toBeUndefined();
  });

  it("rolls back failed bootstrap without resolving or publishing endpoints", async () => {
    const f = await createFixture({
      hooks: { bootstrap: "exit 8", shutdown: "node hook.cjs shutdown" },
    });

    const result = await launch(f.root, f.env, ["start"]).done;
    expect(result.code).toBe(1);
    expect(result.output).toContain("Bootstrap hook exited 8");
    expect(f.proxy.calls).toHaveLength(0);
    await expect(f.store.read()).resolves.toBeUndefined();
    await expect(readFile(path.join(f.root, "hooks.jsonl"), "utf-8")).resolves.toContain(
      "shutdown"
    );
  });

  it("retains failed route cleanup and does not repeat completed shutdown on retry", async () => {
    const f = await createFixture({ run: "exit 0" });
    f.proxy.failDelete();
    const started = await launch(f.root, f.env, ["start"]).done;
    expect(started.code).toBe(1);
    await expect(readFile(path.join(f.root, "hooks.jsonl"), "utf-8")).resolves.toContain(
      "shutdown"
    );
    const pending = await f.store.read();
    assert.ok(pending);
    const expectedEndpoint: unknown = expect.any(Object);
    expect({
      endpoint: pending.endpoints.web,
      routes: f.proxy.routes.length,
      shutdown: pending.shutdown,
      status: pending.status,
    }).toStrictEqual({
      endpoint: expectedEndpoint,
      routes: 1,
      shutdown: undefined,
      status: "stopping",
    });
    f.proxy.failDelete(false);
    const stopped = await launch(f.root, f.env, ["stop"]).done;
    expect({
      code: stopped.code,
      routes: f.proxy.routes,
      session: await f.store.read(),
    }).toStrictEqual({ code: 0, routes: [], session: undefined });
    const contents = await readFile(path.join(f.root, "hooks.jsonl"), "utf-8");

    const hooks = contents
      .trim()
      .split("\n")
      .map((line) => z.record(z.string(), z.string()).parse(JSON.parse(line)));

    expect(hooks.filter((hook) => hook.stage === "shutdown")).toHaveLength(1);
  });

  it("cleans up when publication fails", async () => {
    const f = await createFixture();
    f.proxy.failPublish();
    const started = await launch(f.root, f.env, ["start"]).done;
    expect(started.code).toBe(1);
    await expect(readFile(path.join(f.root, "hooks.jsonl"), "utf-8")).resolves.toContain(
      "shutdown"
    );
    await expect(f.store.read()).resolves.toBeUndefined();
  });

  it("dev stop can cancel startup while bootstrap is still running", async () => {
    const f = await createFixture({
      hooks: {
        bootstrap: "node hook.cjs bootstrap; sleep 60",
        shutdown: "node hook.cjs shutdown",
      },
    });

    const owner = launch(f.root, f.env, ["start"]);
    await waitUntil(async () => {
      const session = await f.store.read();

      return session?.status === "starting";
    }, owner.output);
    const stopped = await launch(f.root, f.env, ["stop"]).done;
    expect(stopped.code).toBe(0);
    const exited = await owner.done;
    expect(exited.code).toBe(143);
    await expect(f.store.read()).resolves.toBeUndefined();
    await expect(readFile(path.join(f.root, "hooks.jsonl"), "utf-8")).resolves.toContain(
      "shutdown"
    );
  }, 15_000);

  it("SIGINT stops the main process and executes shutdown", async () => {
    const f = await createFixture();
    const owner = launch(f.root, f.env, ["start"]);
    await waitUntil(async () => {
      const session = await f.store.read();

      return session?.status === "running";
    }, owner.output);
    owner.child.kill("SIGINT");
    const exited = await owner.done;
    expect(exited.code).toBe(130);
    await expect(f.store.read()).resolves.toBeUndefined();
    expect(f.proxy.routes).toHaveLength(0);
  }, 15_000);

  it.each([
    { code: 130, signal: "SIGINT" },
    { code: 143, signal: "SIGTERM" },
  ] as const)(
    "reports failed shutdown after $signal and preserves its exit code",
    async ({ signal, code }) => {
      const f = await createFixture({ hooks: { shutdown: "exit 4" } });
      const owner = launch(f.root, f.env, ["start"]);
      await waitUntil(async () => {
        const state = await f.store.read();

        return state?.status === "running";
      }, owner.output);
      owner.child.kill(signal);
      const exited = await owner.done;
      expect(exited.code).toBe(code);
      expect(exited.output).toContain("Shutdown hook exited 4");
      const state = await f.store.read();
      expect(state?.shutdown).toBe("exit 4");
    },
    15_000
  );

  it("allows main checkout and linked worktree sessions concurrently", async () => {
    const f = await createFixture();
    await execa("git", ["-C", f.root, "add", "."]);
    await execa("git", [
      "-C",
      f.root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "config",
    ]);
    const linked = path.join(await createTempDir(), "feature");
    await execa("git", ["-C", f.root, "worktree", "add", "-qb", "feature", linked]);
    const otherStore = new Store(await Workspaces.resolve("project", linked), f.state);
    const main = launch(f.root, f.env, ["start"]);
    const other = launch(linked, f.env, ["start"]);
    await waitUntil(
      async () => {
        const session = await f.store.read();
        const resolved = await otherStore.read();

        return session?.status === "running" && resolved?.status === "running";
      },
      () => main.output() + other.output()
    );
    const a = await f.store.read();
    assert.ok(a);
    const b = await otherStore.read();
    assert.ok(b);
    expect(a.workspace).not.toBe(b.workspace);
    expect(a.env.WEB_PORT).not.toBe(b.env.WEB_PORT);
    expect(f.proxy.routes).toHaveLength(2);
    await launch(f.root, f.env, ["stop"]).done;
    await main.done;
    expect(f.proxy.routes).toHaveLength(1);
    await launch(linked, f.env, ["stop"]).done;
    await other.done;
    expect(f.proxy.routes).toHaveLength(0);
  }, 25_000);

  it.each([false, true])(
    "recovers a killed owner and reaps its tree with a missing leader: %s",
    async (hasMissingLeader) => {
      const f = await createFixture();
      const owner = launch(f.root, f.env, ["start"]);
      await waitUntil(async () => {
        const s = await f.store.read();

        return s?.status === "running" && !!s.process;
      }, owner.output);
      const old = await f.store.read();
      assert.ok(old);
      await waitUntil(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${old.env.WEB_PORT}`);

          return response.ok;
        } catch {
          return false;
        }
      });
      owner.child.kill("SIGKILL");
      await owner.done;

      if (hasMissingLeader) {
        assert.ok(old.process);
        const leader = old.process.pid;
        process.kill(leader, "SIGKILL");
        await waitUntil(async () => {
          const identity = await Identity.get(leader);

          return !(identity.startToken ?? "");
        });
      }

      const stopped = await launch(f.root, f.env, ["stop"]).done;
      expect({
        code: stopped.code,
        routes: f.proxy.routes,
        session: await f.store.read(),
      }).toStrictEqual({ code: 0, routes: [], session: undefined });
      await expect(fetch(`http://127.0.0.1:${old.env.WEB_PORT}`)).rejects.toThrow("fetch failed");
      const next = launch(f.root, f.env, ["start"]);
      await waitUntil(async () => {
        const session = await f.store.read();

        return session?.status === "running";
      }, next.output);
      await launch(f.root, f.env, ["stop"]).done;
      await next.done;
    },
    25_000
  );

  it("serializes two simultaneous starts before either has published a session", async () => {
    const f = await createFixture({
      hooks: { bootstrap: "sleep 1", shutdown: "node hook.cjs shutdown" },
    });

    const a = launch(f.root, f.env, ["start"]);
    const b = launch(f.root, f.env, ["start"]);
    await waitUntil(
      async () => {
        const session = await f.store.read();

        return session?.status === "running";
      },
      () => a.output() + b.output()
    );
    const loser = await Promise.race([a.done, b.done]);
    expect(loser.code).toBe(1);
    expect(loser.output).toContain("already running");
    expect(f.proxy.routes).toHaveLength(1);
    await launch(f.root, f.env, ["stop"]).done;
    await Promise.all([a.done, b.done]);
  }, 25_000);

  it("cancels a command expression without starting the run command", async () => {
    const f = await createFixture({ env: { WAIT: `\${exec('sleep 60')}` } });
    const owner = launch(f.root, f.env, ["start"]);
    await waitUntil(async () => {
      const s = await f.store.read();

      return s?.status === "starting" && !!s.process && f.proxy.calls.length > 0;
    }, owner.output);
    await launch(f.root, f.env, ["stop"]).done;
    const exited = await owner.done;
    expect(exited.code).toBe(143);
    await expect(f.store.read()).resolves.toBeUndefined();
    expect(f.proxy.routes).toHaveLength(0);
  }, 15_000);

  it("fails without a compatible proxy and rolls back infrastructure", async () => {
    const f = await createFixture();

    const result = await launch(f.root, { ...f.env, CADDY_ADMIN: "http://127.0.0.1:1" }, ["start"])
      .done;

    expect(result.code).toBe(1);
    expect(result.output).toContain("No supported local proxy");
    await expect(readFile(path.join(f.root, "hooks.jsonl"), "utf-8")).resolves.toContain(
      "shutdown"
    );
    await expect(f.store.read()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")(
    "never signals a live process whose PID belongs to a stale owner record",
    async () => {
      const f = await createFixture();

      const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });

      children.push(unrelated);
      assert.ok(unrelated.pid !== undefined && unrelated.pid !== 0);
      await f.store.write({
        endpoints: {},
        env: {},
        id: "stale-owner",
        ownerStartToken: "not-the-process-start-time",
        pendingRoutes: [],
        pid: unrelated.pid,
        root: f.root,
        startedAt: new Date().toISOString(),
        status: "running",
        version: 1,
        workspace: "project",
      });
      const result = await launch(f.root, f.env, ["stop"]).done;
      expect(result.code).toBe(0);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      await expect(f.store.read()).resolves.toBeUndefined();
    }
  );

  it("resolves Docker endpoints after bootstrap and reuses Docker env values in exec", async () => {
    const f = await createFixture({
      endpoints: Object.fromEntries<Config["endpoints"][string]>([
        ["web", { port: `\${port()}`, root: true }],
        ["mail", `\${docker.compose.port('mailpit', 8025)}`],
      ]),
      env: Object.fromEntries([
        ["POSTGRES_PORT", `\${docker.compose.port('postgres', 5432)}`],
        ["DATABASE_URL", `postgresql://localhost:\${env('POSTGRES_PORT')}/app`],
      ]),
    });

    const [bin] = f.env.PATH.split(":");
    assert.ok(bin !== undefined && bin !== "");
    await writeFile(
      path.join(bin, "docker"),
      `#!/usr/bin/env node
const { existsSync } = require("node:fs");
if (!existsSync("hooks.jsonl")) process.exit(5);
if (process.env.COMPOSE_PROJECT_NAME !== "project") process.exit(6);
const service = process.argv.at(-1);
const isMail = service === "mailpit";
process.stdout.write(JSON.stringify({
  ID: (isMail ? "a" : "b").repeat(64),
  Name: "project-" + service + "-1",
  Command: isMail ? "/mailpit" : "docker-entrypoint.sh postgres",
  Project: "project",
  Service: service,
  State: "running",
  Health: "",
  ExitCode: 0,
  Publishers: [{
  URL: "::",
  TargetPort: isMail ? 8025 : 5432,
  PublishedPort: isMail ? 48025 : 45432,
  Protocol: "tcp",
}] }));
`,
      { mode: 0o755 }
    );
    const owner = launch(f.root, f.env, ["start"]);
    await waitUntil(async () => {
      const session = await f.store.read();

      return session?.status === "running";
    }, owner.output);
    const session = await f.store.read();
    assert.ok(session);
    expect(session.env.MAIL_PORT).toBe("48025");
    expect(session.env.DATABASE_URL).toBe("postgresql://localhost:45432/app");

    const result = await launch(f.root, f.env, ["exec", "node", "-p", "process.env.DATABASE_URL"])
      .done;

    expect(result.output.trim()).toBe(session.env.DATABASE_URL);
    await launch(f.root, f.env, ["stop"]).done;
    await owner.done;
  }, 15_000);

  it.each(["invalid", "missing"])(
    "manages the active session when startup configuration is %s",
    async (configuration) => {
      const f = await createFixture();
      const owner = launch(f.root, f.env, ["start"]);
      await waitUntil(async () => {
        const session = await f.store.read();

        return session?.status === "running";
      }, owner.output);
      const session = await f.store.read();
      assert.ok(session);
      await (configuration === "missing"
        ? rm(path.join(f.root, "package.json"))
        : writeConfig(f.root, { name: "changed", run: { invalid: true } }));
      const info = await launch(f.root, f.env, ["status"]).done;
      const expectedOutput: unknown = expect.stringContaining("project");
      expect(info).toMatchObject({
        code: 0,
        output: expectedOutput,
      });
      expect(info.output).toContain("running");

      const executed = await launch(f.root, f.env, ["exec", "node", "-p", "process.env.WEB_PORT"])
        .done;

      expect({
        code: executed.code,
        output: executed.output.trim(),
      }).toStrictEqual({ code: 0, output: session.env.WEB_PORT });
      const stopped = await launch(f.root, f.env, ["stop"]).done;
      await owner.done;
      expect({
        code: stopped.code,
        routes: f.proxy.routes,
        session: await f.store.read(),
      }).toStrictEqual({ code: 0, routes: [], session: undefined });
      const status2 = await launch(f.root, f.env, ["status"]).done;
      expect(status2.code).toBe(0);
    }
  );

  it("blocks restart until a failed shutdown can complete", async () => {
    const shutdown = "node shutdown.cjs";
    const f = await createFixture({ hooks: { shutdown }, run: "exit 0" });
    await writeFile(
      path.join(f.root, "shutdown.cjs"),
      `
const { appendFileSync, existsSync } = require("node:fs");
appendFileSync("attempts", "shutdown\\n");
process.exitCode = existsSync("allow-shutdown") ? 0 : 1;
`
    );
    const started = await launch(f.root, f.env, ["start"]).done;
    const pending = await f.store.read();
    assert.ok(pending);
    expect({
      code: started.code,
      pendingRoutes: pending.pendingRoutes,
      shutdown: pending.shutdown,
    }).toStrictEqual({ code: 1, pendingRoutes: [], shutdown });
    const next = await launch(f.root, f.env, ["start"]).done;
    const expectedOutput: unknown = expect.stringContaining("Stale session cleanup failed");
    expect(next).toMatchObject({
      code: 1,
      output: expectedOutput,
    });
    const session2 = await f.store.read();
    expect(session2?.id).toBe(pending.id);
    await writeFile(path.join(f.root, "allow-shutdown"), "");
    const stopped = await launch(f.root, f.env, ["stop"]).done;
    expect({ code: stopped.code, session: await f.store.read() }).toStrictEqual({
      code: 0,
      session: undefined,
    });
    const contents = await readFile(path.join(f.root, "attempts"), "utf-8");
    expect(contents.trim().split("\n")).toHaveLength(3);
  }, 20_000);

  it("journals and reaps a shutdown hook after its recovery owner is killed", async () => {
    const f = await createFixture({
      hooks: { shutdown: "node shutdown.cjs" },
    });

    await writeFile(
      path.join(f.root, "shutdown.cjs"),
      `
const { existsSync, writeFileSync, readFileSync } = require("node:fs");
if (!existsSync("shutdown-pid")) {
  writeFileSync("shutdown-pid", String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const pid = Number(readFileSync("shutdown-pid", "utf8"));
  try {
    process.kill(pid, 0);
    process.stderr.write("previous shutdown still alive");
    process.exitCode = 1;
  } catch {
    writeFileSync("shutdown-complete", "done");
  }
}
`
    );
    const owner = launch(f.root, f.env, ["start"]);
    await waitUntil(async () => {
      const session = await f.store.read();

      return session?.status === "running" && !!session.process;
    }, owner.output);
    owner.child.kill("SIGKILL");
    await owner.done;
    const recovery = launch(f.root, f.env, ["stop"]);
    await waitUntil(async () => {
      const session = await f.store.read();

      if (session?.status !== "stopping" || !session.process) {
        return false;
      }

      try {
        await readFile(path.join(f.root, "shutdown-pid"));

        return true;
      } catch {
        return false;
      }
    }, recovery.output);
    const session2 = await f.store.read();
    expect(session2?.pid).toBe(recovery.child.pid);
    recovery.child.kill("SIGKILL");
    await recovery.done;
    const stopped = await launch(f.root, f.env, ["stop"]).done;
    expect(stopped).toMatchObject({ code: 0 });
    await expect(readFile(path.join(f.root, "shutdown-complete"), "utf-8")).resolves.toBe("done");
    await expect(f.store.read()).resolves.toBeUndefined();
  }, 30_000);
});
