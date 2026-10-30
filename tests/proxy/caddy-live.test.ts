import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer, get, IncomingMessage } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";

import { createTempDir } from "@tests/helpers";
import getPort from "get-port";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { inherit } from "@/env/resolve";
import { Caddy } from "@/proxy/caddy";
import { detect } from "@/proxy/detect";

// node:http preserves the virtual Host header when connecting over loopback.
async function readRoute(port: string, hostname: string, pathname: string): Promise<string> {
  const request = get(`http://127.0.0.1:${port}${pathname}`, {
    agent: false,
    headers: { Host: hostname },
  });

  const [response] = z
    .tuple([z.instanceof(IncomingMessage)])
    .parse(await once(request, "response"));

  const body = await text(response);

  return body;
}

describe("caddy-live", () => {
  it
    .skipIf(!(process.env.CADDY_TEST_BINARY ?? ""))
    .each(["configured", "empty", "no-apps", "unrelated"])(
    "sets up and proxies traffic through a %s Caddy instance",
    async (configuration) => {
      const root = await createTempDir();

      const upstream = createServer((req, res) => {
        res.end(`upstream:${req.url}`);
      });

      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const adminPort = await getPort();
      const publicPort = await getPort();
      const config = path.join(root, "caddy.json");

      const apps = {
        http: {
          servers: {
            [configuration === "configured" ? "dev" : "unrelated"]: {
              automatic_https: { disable: true },
              listen: [`127.0.0.1:${publicPort}`],
              routes: [],
            },
          },
        },
      };

      const initialApps = configuration === "empty" ? {} : apps;
      await writeFile(
        config,
        JSON.stringify({
          admin: { listen: `127.0.0.1:${adminPort}` },
          apps: configuration === "no-apps" ? undefined : initialApps,
        })
      );

      const child = spawn(
        z.string().min(1).parse(process.env.CADDY_TEST_BINARY),
        ["run", "--config", config],
        {
          env: { ...process.env, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root },
          stdio: ["ignore", "ignore", "pipe"],
        }
      );

      let output = "";
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const exited = once(child, "exit");

      try {
        const provider = new Caddy({
          admin: `http://127.0.0.1:${adminPort}`,
          applicationPorts: [8080],
          env: { ...inherit(), DEV_STATE_DIR: root },
        });

        await expect
          .poll(
            async () => {
              if (child.exitCode !== null) {
                throw new Error(output);
              }

              return await provider.isAvailable();
            },
            { interval: 50, timeout: 2500 }
          )
          .toBeTruthy();
        await provider.ensureReady();
        await provider.publish({
          hostname: "web.project.localhost",
          owner: "test-session",
          port: z.object({ port: z.number().int().positive() }).parse(upstream.address()).port,
          root: ".",
        });
        const url = new URL(await provider.getEndpointUrl("web.project.localhost"));
        expect(url.hostname).toBe("web.project.localhost");
        expect(url.port).not.toBe("8080");

        const servers = await fetch(`http://127.0.0.1:${adminPort}/config/apps/http/servers`, {
          headers: {
            Connection: "close",
            Origin: `http://127.0.0.1:${adminPort}`,
          },
        });

        const initialServer = ["empty", "no-apps"].includes(configuration)
          ? {}
          : {
              [configuration === "configured" ? "dev" : "unrelated"]: {
                listen: [`127.0.0.1:${publicPort}`],
              },
            };

        await expect(servers.json()).resolves.toMatchObject(initialServer);
        await expect(readRoute(url.port, "web.project.localhost", "/test")).resolves.toBe(
          "upstream:/test"
        );
        await provider.unpublish({
          hostname: "web.project.localhost",
          owner: "test-session",
        });

        const response2 = await fetch(
          `http://127.0.0.1:${adminPort}/config/apps/http/servers/dev/routes`,
          {
            headers: {
              Connection: "close",
              Origin: `http://127.0.0.1:${adminPort}`,
            },
          }
        );

        await expect(response2.json()).resolves.toStrictEqual([]);
      } finally {
        child.kill("SIGTERM");
        await exited;
        await upstream[Symbol.asyncDispose]();
      }
    },
    15_000
  );

  it.skipIf(!(process.env.CADDY_TEST_BINARY ?? ""))(
    "detects an installed binary, starts it once for concurrent workspaces, and keeps other routes live",
    async () => {
      const root = await createTempDir();
      const bin = path.join(root, "bin");
      await mkdir(bin);
      await symlink(z.string().parse(process.env.CADDY_TEST_BINARY), path.join(bin, "caddy"));
      await writeFile(path.join(bin, "portless"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      const adminPort = await getPort();
      const admin = `http://127.0.0.1:${adminPort}`;

      const env = {
        ...inherit(),
        CADDY_ADMIN: admin,
        DEV_STATE_DIR: root,
        PATH: `${bin}:${process.env.PATH}`,
      };

      const upstream = createServer((req, res) => {
        res.end(`managed:${req.url}`);
      });

      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");

      try {
        const [first, second] = await Promise.all([
          detect(root, { applicationPorts: [8080], env }),
          detect(root, { applicationPorts: [8080], env }),
        ]);

        expect(first.getState()).toStrictEqual(second.getState());
        const { port } = z.object({ port: z.number() }).parse(upstream.address());
        await first.publish({
          hostname: "one.localhost",
          owner: "test-session",
          port,
          root: ".",
        });
        await second.publish({
          hostname: "two.localhost",
          owner: "test-session",
          port,
          root: ".",
        });
        const url = new URL(await first.getEndpointUrl("one.localhost"));
        expect(url.port).not.toBe("8080");
        await expect(readRoute(url.port, "one.localhost", "/test")).resolves.toBe("managed:/test");
        await first.unpublish({
          hostname: "one.localhost",
          owner: "test-session",
        });
        await expect(readRoute(url.port, "two.localhost", "/other")).resolves.toBe(
          "managed:/other"
        );
        const next = await detect(root, { env });
        expect(next.getState()).toStrictEqual(first.getState());
        await second.unpublish({
          hostname: "two.localhost",
          owner: "test-session",
        });
      } finally {
        await fetch(`${admin}/stop`, {
          headers: { Origin: admin },
          method: "POST",
        }).catch(() => {});
        upstream.closeAllConnections();
        await upstream[Symbol.asyncDispose]();
      }
    },
    20_000
  );
});
