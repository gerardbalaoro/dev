import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

import type { FixtureValue } from "@tests/helpers";
import { z } from "zod";

const RouteSchema = z.object({ "@id": z.string() }).catchall(z.json());

export async function createCaddy(servers?: FixtureValue) {
  const routes: z.infer<typeof RouteSchema>[] = [];
  const calls: string[] = [];
  let shouldFailPublish = false;
  let shouldFailDelete = false;
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    calls.push(`${req.method} ${path}`);
    res.setHeader("Content-Type", "application/json");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
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
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  return {
    admin: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => {
      server.closeAllConnections();
      return promisify(server.close.bind(server))();
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
