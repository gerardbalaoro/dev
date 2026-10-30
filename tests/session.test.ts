import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createGitRepo, createTempDir } from "@tests/helpers";
import { describe, expect, it } from "vitest";

import { Identity } from "@/process/identity";
import { Journal } from "@/session/lifecycle";
import { acquire } from "@/session/lock";
import { Store } from "@/session/store";
import type { Session } from "@/session/types";
import { UI } from "@/ui/index";
import { Workspaces } from "@/workspace/resolve";

describe("session", () => {
  it("retains separate cleanup failures and still attempts shutdown after route failure", async () => {
    const workspace = await Workspaces.resolve("project", await createGitRepo());
    const store = new Store(workspace, await createTempDir());
    const journal = await Journal.create(workspace, store);
    await journal.reserve({ web: "3000" }, "exit 4");
    const [claim] = await readdir(store.routesDirectory);

    if (claim === undefined || claim === "") {
      throw new Error("Missing route claim");
    }

    await writeFile(path.join(store.routesDirectory, claim), "invalid JSON");

    const failure = await journal.cleanup({
      ...UI,
      error() {},
      output: () => ({ finish() {}, write() {} }),
    });

    expect(failure).toBeInstanceOf(AggregateError);

    if (!(failure instanceof AggregateError)) {
      throw new TypeError("Expected cleanup failures");
    }

    expect(failure.errors).toStrictEqual([
      expect.any(SyntaxError),
      expect.objectContaining({ message: "Shutdown hook exited 4" }),
    ]);
    const pending = await store.read();
    expect(pending?.pendingRoutes).toHaveLength(1);
    expect(pending?.shutdown).toBe("exit 4");
  });

  it("writes private state atomically and does not remove a different session", async () => {
    const workspace = await Workspaces.resolve("project", await createGitRepo());
    const store = new Store(workspace, await createTempDir());
    const owner = await Identity.get(process.pid);

    const session: Session = {
      endpoints: {},
      env: { SECRET: "value" },
      id: "one",
      ownerStartToken: owner.startToken,
      pendingRoutes: [],
      pid: process.pid,
      root: workspace.root,
      startedAt: new Date().toISOString(),
      status: "running",
      version: 1,
      workspace: workspace.name,
    };

    await store.write(session);
    await expect(store.read()).resolves.toStrictEqual(session);
    const stats = await stat(store.file);
    expect(stats.mode % 0o1000).toBe(0o600);
    await store.remove("different");
    await expect(store.read()).resolves.toStrictEqual(session);
    await expect(acquire(store)).rejects.toThrow("already running");
    await store.remove("one");
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("uses the root for lock identity even when the configured project name changes", async () => {
    const root = await createGitRepo();
    const state = await createTempDir();
    const a = new Store(await Workspaces.resolve("first", root), state);
    const b = new Store(await Workspaces.resolve("second", root), state);
    const release = await acquire(a);

    try {
      await expect(acquire(b)).rejects.toThrow("already running");
    } finally {
      await release();
    }

    const releaseSecond = await acquire(b);
    await releaseSecond();
  }, 10_000);

  it.each([
    { data: { origin: "http://localhost", server: "dev" }, provider: "caddy" },
    {
      data: { admin: "invalid", origin: "http://localhost", server: "dev" },
      provider: "caddy",
    },
    { provider: "portless" },
    { data: { PATH: "/unexpected" }, provider: "portless" },
    { data: {}, provider: "unknown" },
  ])("rejects malformed proxy recovery state before use: %j", async (proxy) => {
    const workspace = await Workspaces.resolve("project", await createGitRepo());
    const store = new Store(workspace, await createTempDir());
    await store.prepare();
    const owner = await Identity.get(process.pid);
    await writeFile(
      store.file,
      JSON.stringify({
        endpoints: {},
        env: {},
        id: "invalid-proxy",
        ownerStartToken: owner.startToken,
        pendingRoutes: [],
        pid: process.pid,
        proxy,
        root: workspace.root,
        startedAt: new Date().toISOString(),
        status: "stopping",
        version: 1,
        workspace: workspace.name,
      })
    );
    await expect(store.read()).rejects.toThrow("Cannot read session");
  });
});
