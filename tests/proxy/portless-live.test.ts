import { once } from "node:events";
import { createServer, get, IncomingMessage } from "node:http";
import { text } from "node:stream/consumers";

import { createTempDir } from "@tests/helpers";
import getPort from "get-port";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { inherit } from "@/env/resolve";
import { run } from "@/process/run";
import { Portless } from "@/proxy/portless";

describe("portless-live", () => {
  it.skipIf(!(process.env.PORTLESS_TEST_BINARY ?? ""))(
    "publishes and removes a real external Portless alias",
    async () => {
      const root = await createTempDir();
      const port = await getPort();

      const env = {
        ...inherit(),
        NO_COLOR: "1",
        PORTLESS_HTTPS: "0",
        PORTLESS_LAN: "0",
        PORTLESS_PORT: String(port),
        PORTLESS_STATE_DIR: root,
        PORTLESS_SYNC_HOSTS: "0",
        PORTLESS_TLD: "localhost",
      };

      const runner = async (args: string[]) => {
        const result = await run(
          [z.string().min(1).parse(process.env.PORTLESS_TEST_BINARY), ...args],
          {
            cwd: root,
            env,
            shouldCapture: true,
            signal: AbortSignal.timeout(15_000),
          }
        );

        if (result.code) {
          throw new Error(result.stderr || result.stdout);
        }

        return result.stdout.trim();
      };

      const upstream = createServer((_req, res) => {
        res.end("portless-upstream");
      });

      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const provider = new Portless(root, { runner });

      try {
        await expect(provider.isAvailable()).resolves.toBeTruthy();
        await provider.ensureReady();
        await expect(provider.getEndpointUrl("api.project.localhost")).resolves.toBe(
          `http://api.project.localhost:${port}`
        );
        await provider.publish({
          hostname: "api.project.localhost",
          owner: "test-session",
          port: z.object({ port: z.number().int().positive() }).parse(upstream.address()).port,
          root: ".",
        });

        const fetchUpstream = async () => {
          // node:http preserves the virtual Host header when connecting over loopback.
          const request = get(`http://127.0.0.1:${port}`, {
            agent: false,
            headers: { Host: "api.project.localhost" },
          });

          const [response] = z
            .tuple([z.instanceof(IncomingMessage)])
            .parse(await once(request, "response"));

          const body = await text(response);

          return response.statusCode === 200 ? body : `HTTP ${response.statusCode}`;
        };

        // Portless debounces its shared route-file watcher.
        await expect.poll(fetchUpstream, { interval: 50, timeout: 2000 }).toBe("portless-upstream");
        await provider.unpublish({
          hostname: "api.project.localhost",
          owner: "test-session",
        });
        await expect
          .poll(fetchUpstream, { interval: 50, timeout: 2000 })
          .not.toBe("portless-upstream");
        await provider.unpublish({
          hostname: "api.project.localhost",
          owner: "test-session",
        });
      } finally {
        await runner(["proxy", "stop"]);
        await upstream[Symbol.asyncDispose]();
      }
    },
    25_000
  );
});
