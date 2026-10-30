import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { createTempDir } from "@tests/helpers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { inherit } from "@/env/resolve";
import { restore } from "@/proxy/detect";
import { Portless } from "@/proxy/portless";

describe("portless", () => {
  it.skipIf(process.platform === "win32").each([false, true])(
    "removes only the original alias after state directory settings change (explicit: %s)",
    async (hasStateDirectory) => {
      const root = await createTempDir();
      await writeFile(
        path.join(root, "portless"),
        `#!${process.execPath}
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const [command, name, port] = process.argv.slice(2);
if (command !== "alias") process.exit(1);
const directory = process.env.PORTLESS_STATE_DIR || path.join(process.cwd(), "default");
mkdirSync(directory, { recursive: true });
if (name === "--remove") {
  rmSync(path.join(directory, port), { force: true });
} else {
  writeFileSync(path.join(directory, name), port);
}
`,
        { mode: 0o700 }
      );

      const env = {
        ...Object.fromEntries(
          Object.entries(inherit()).filter(([key]) => !key.startsWith("PORTLESS_"))
        ),
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      };

      const directory = path.join(root, hasStateDirectory ? "original" : "default");

      const original = new Portless(root, {
        env: hasStateDirectory ? { ...env, PORTLESS_STATE_DIR: directory } : env,
      });

      const claim = {
        hostname: "api.project.localhost",
        owner: "test-session",
        port: 43_100,
        root,
      };

      await original.publish(claim);
      const changed = { ...env, PORTLESS_STATE_DIR: path.join(root, "other") };
      await new Portless(root, { env: changed }).publish({
        ...claim,
        port: 43_200,
      });

      await restore(original.getState(), root, changed).unpublish(claim);

      await expect(readFile(path.join(directory, "api.project"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(path.join(root, "other", "api.project"), "utf-8")).resolves.toBe(
        "43200"
      );
    }
  );

  it("uses provider URLs without worktree rewriting and only owns static aliases", async () => {
    const server = createServer((socket) => {
      socket.end();
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z.object({ port: z.number().int().positive() }).parse(server.address());

    const runner = vi.fn<(args: string[]) => Promise<string>>(
      async (args) =>
        await Promise.resolve(args[0] === "get" ? `http://${args[1]}.localhost:${port}` : "")
    );

    try {
      const provider = new Portless(".", { runner });
      await provider.ensureReady();
      await expect(provider.getEndpointUrl("api.project.localhost")).resolves.toBe(
        `http://api.project.localhost:${port}`
      );
      await provider.publish({
        hostname: "api.project.localhost",
        owner: "test-session",
        port: 43_100,
        root: ".",
      });
      await provider.unpublish({
        hostname: "api.project.localhost",
        owner: "test-session",
      });
      expect(runner).toHaveBeenCalledWith(["get", "dev-provider-probe", "--no-worktree"]);
      expect(runner).toHaveBeenCalledWith(["alias", "api.project", "43100"]);
      expect(runner).toHaveBeenCalledWith(["alias", "--remove", "api.project"]);
      expect(runner.mock.calls.some(([args]) => args.includes("run"))).toBeFalsy();
    } finally {
      await server[Symbol.asyncDispose]();
    }
  });

  it("rejects URL hostname rewriting", async () => {
    const provider = new Portless(".", {
      runner: async () => await Promise.resolve("https://rewritten.test"),
    });

    await expect(provider.getEndpointUrl("api.project.localhost")).rejects.toThrow(
      "logical .localhost"
    );
  });
});
