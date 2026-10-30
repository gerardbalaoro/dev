/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks, anti-slop/no-unknown-parameters -- The HTTP callback cannot await; handle request failures at its boundary. */
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

import type { FixtureValue } from "@tests/helpers";
import { z } from "zod";

const RouteSchema = z.object({ "@id": z.string() }).catchall(z.json());

export async function createCaddy(servers?: FixtureValue) {
  const routes: z.infer<typeof RouteSchema>[] = [];
  const calls: string[] = [];
  let shouldFailPublish = false;
  let shouldFailDelete = false;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url ?? "/";
    calls.push(`${req.method} ${path}`);
    res.setHeader("Content-Type", "application/json");
    const body = await text(req);
    if (req.method === "GET" && path.startsWith("/config/")) {
      let value: FixtureValue = {
        apps: {
          http: {
            servers:
              servers === undefined
                ? {
                    dev: {
                      automatic_https: { disable: true },
                      listen: [":8080"],
                      routes,
                    },
                  }
                : servers,
          },
        },
      };
      for (const segment of path.slice("/config/".length).split("/").filter(Boolean)) {
        const object = z.record(z.string(), z.json()).safeParse(value);
        value = object.success ? (object.data[segment] ?? null) : null;
      }
      res.end(JSON.stringify(value));
      return;
    }
    if (path === "/config/apps/http/servers/dev/routes/0" && req.method === "PUT") {
      if (shouldFailPublish) {
        res.writeHead(500).end("{}");
        return;
      }
      routes.unshift(RouteSchema.parse(JSON.parse(body)));
      res.end();
      return;
    }
    if (path.startsWith("/id/")) {
      const index = routes.findIndex((route) => route["@id"] === path.slice(4));
      if (index === -1) {
        res.writeHead(404).end("{}");
        return;
      }
      if (req.method === "DELETE") {
        if (shouldFailDelete) {
          res.writeHead(500).end("{}");
          return;
        }
        routes.splice(index, 1);
        res.end();
        return;
      }
      if (req.method === "PATCH") {
        routes[index] = RouteSchema.parse(JSON.parse(body));
        res.end();
        return;
      }
      res.end(JSON.stringify(routes[index]));
      return;
    }
    res.writeHead(404).end("{}");
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  return {
    admin: `http://127.0.0.1:${address.port}`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
    failDelete: (shouldFail = true) => {
      shouldFailDelete = shouldFail;
    },
    failPublish: () => {
      shouldFailPublish = true;
    },
    routes,
  };
}
