import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setInterval as interval } from "node:timers/promises";

import getPort from "get-port";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { JSONType } from "zod";

import { inherit } from "@/env/resolve";
import { run } from "@/process/run";
import type { Provider, CaddyState, RouteClaim } from "@/proxy/types";
import { Sessions } from "@/session/store";
import { hash } from "@/utils/hash";

const ServersSchema = z.object({
  dev: z.object({
    automatic_https: z.object({ disable: z.boolean().optional() }).optional(),
    listen: z.tuple([z.string()]),
    routes: z.array(z.record(z.string(), z.unknown())),
    tls_connection_policies: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
});

interface CaddyOptions {
  applicationPorts?: number[];
  admin?: string;
  state?: CaddyState;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export class Caddy implements Provider {
  private readonly options: CaddyOptions;

  readonly id = "caddy";
  private server?: string;
  private origin?: string;
  private readonly admin: string;
  private readonly env: Record<string, string>;

  constructor(options: CaddyOptions = {}) {
    this.options = options;
    this.env = options.env ?? inherit();

    this.admin =
      options.state?.data.admin ?? options.admin ?? this.env.CADDY_ADMIN ?? "http://127.0.0.1:2019";
    this.server = options.state?.data.server;
    this.origin = options.state?.data.origin;
  }

  private async request(
    location: string,
    method = "GET",
    body?: JSONType,
    canBeMissing = false
  ): Promise<JSONType | undefined> {
    const timeout = AbortSignal.timeout(3000);
    const options: RequestInit = {
      headers: {
        // Config updates can restart the admin listener and close idle sockets.
        Connection: "close",
        "Content-Type": "application/json",
        Origin: new URL(this.admin).origin,
      },
      method,
      signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
    };
    if (method !== "GET" && body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${this.admin}${location}`, options);
    if (canBeMissing && response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Caddy ${method} ${location}: ${response.status} ${await response.text()}`);
    }
    const text = await response.text();
    return text ? z.json().parse(JSON.parse(text)) : undefined;
  }

  private async isRunning(): Promise<boolean> {
    try {
      await this.request("/config/");
      return true;
    } catch {
      this.options.signal?.throwIfAborted();
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (await this.isRunning()) {
      return true;
    }
    try {
      const result = await run(["caddy", "version"], {
        cwd: process.cwd(),
        env: this.env,
        shouldCapture: true,
        signal: AbortSignal.any([
          ...(this.options.signal ? [this.options.signal] : []),
          AbortSignal.timeout(3000),
        ]),
      });
      return result.code === 0;
    } catch {
      this.options.signal?.throwIfAborted();
      return false;
    }
  }

  private async start(directory: string): Promise<void> {
    const admin = new URL(this.admin);
    if (
      admin.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(admin.hostname)
    ) {
      throw new Error(`Cannot start Caddy for non-local admin address ${this.admin}`);
    }
    const config = path.join(directory, "caddy.json");
    await writeFile(
      config,
      JSON.stringify({
        admin: { config: { persist: false }, listen: admin.host },
        apps: {
          http: { servers: { dev: await this.createServer() } },
        },
      }),
      { mode: 0o600 }
    );
    const logfile = path.join(directory, "caddy.log");
    const log = await open(logfile, "a", 0o600);
    const child = spawn("caddy", ["run", "--config", config], {
      cwd: directory,
      detached: true,
      env: this.env,
      stdio: ["ignore", log.fd, log.fd],
    });
    try {
      await once(child, "spawn");
      for await (const deadline of interval(50, Date.now() + 5000, {
        signal: this.options.signal,
      })) {
        if (Date.now() >= deadline) {
          break;
        }
        this.options.signal?.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) {
          break;
        }
        if (await this.isRunning()) {
          child.unref();
          return;
        }
      }
      const output = await readFile(logfile, "utf-8");
      throw new Error(`Caddy did not start: ${output.slice(-4096)}`);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    } finally {
      await log.close();
    }
  }

  private async createServer() {
    const port = await getPort({
      exclude: this.options.applicationPorts,
      host: "127.0.0.1",
      port: 8080,
    });
    return {
      automatic_https: { disable: true },
      listen: [`127.0.0.1:${port}`],
      routes: [],
    };
  }

  private async setup(): Promise<void> {
    // PUT only creates missing objects, so concurrent API clients cannot be overwritten.
    await Array.fromAsync(
      [
        "/config/apps",
        "/config/apps/http",
        "/config/apps/http/servers",
        "/config/apps/http/servers/dev",
      ],
      async (location) => {
        const existing = await this.request(location, "GET", undefined, true);
        if (existing !== undefined && existing !== null) {
          return;
        }
        const value = location.endsWith("/dev") ? await this.createServer() : {};
        try {
          await this.request(location, "PUT", value);
        } catch (error) {
          // Another process may have created this object since our read.
          const current = await this.request(location, "GET", undefined, true);
          if (current === undefined || current === null) {
            throw error;
          }
        }
      }
    );
  }

  async ensureReady(): Promise<void> {
    if (this.options.applicationPorts?.includes(Number(new URL(this.admin).port || 80))) {
      throw new Error("Caddy admin listener conflicts with an application port");
    }
    const directory = path.join(Sessions.directory(this.env), "proxy", hash(this.admin));
    await mkdir(directory, { mode: 0o700, recursive: true });
    const release = await lockfile.lock(path.join(directory, "setup"), {
      realpath: false,
      retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 100 },
    });
    try {
      this.options.signal?.throwIfAborted();
      if (!(await this.isRunning())) {
        await this.start(directory);
      }
      await this.setup();
      await this.readServer();
    } finally {
      await release();
    }
  }

  private async readServer(): Promise<void> {
    const servers = ServersSchema.safeParse(await this.request("/config/apps/http/servers"));
    // The dedicated dev server keeps routes ahead of unrelated catch-all handlers.
    if (!servers.success) {
      throw new Error(
        'Caddy has an incompatible HTTP server named "dev"; expected one local listener and a routes array',
        { cause: servers.error }
      );
    }
    const server = servers.data.dev;
    const [address] = server.listen;
    const match = /^(?:(?:127\.0\.0\.1|localhost|\[::1\]))?:(?<port>\d+)$/u.exec(address);
    if (!match) {
      throw new Error("Caddy dev listener must use a local TCP port");
    }
    const port = Number(match.groups?.port);
    if (this.options.applicationPorts?.includes(port)) {
      throw new Error(`Caddy listener conflicts with application port ${port}`);
    }
    if (port < 1 || port > 65_535) {
      throw new Error("Invalid Caddy listener port");
    }
    const hasTls = (server.tls_connection_policies?.length ?? 0) > 0;
    if (!hasTls && !server.automatic_https?.disable) {
      throw new Error(
        "Caddy HTTP dev server must disable automatic_https, or configure TLS policies"
      );
    }
    this.server = "dev";
    const protocol = hasTls ? "https" : "http";
    this.origin = new URL(`${protocol}://localhost:${port}`).origin;
  }

  getEndpointUrl(hostname: string): Promise<string> {
    if (!this.origin) {
      return Promise.reject(new Error("Caddy is not ready"));
    }
    const url = new URL(this.origin);
    url.hostname = hostname;
    return Promise.resolve(url.origin);
  }

  private static getRouteId(claim: Pick<RouteClaim, "hostname" | "owner">): string {
    return `dev-${hash(`${claim.owner}:${claim.hostname}`).slice(0, 24)}`;
  }

  async publish(claim: RouteClaim): Promise<void> {
    if (!this.server) {
      throw new Error("Caddy is not ready");
    }
    const { hostname, port } = claim;
    const id = Caddy.getRouteId(claim);
    const route = {
      "@id": id,
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: `127.0.0.1:${port}` }],
        },
      ],
      match: [{ host: [hostname] }],
      terminal: true,
    };
    const existing = await this.request(`/id/${id}`, "GET", undefined, true);
    if (existing) {
      await this.request(`/id/${id}`, "PATCH", route);
      return;
    }
    await this.request(
      `/config/apps/http/servers/${encodeURIComponent(this.server)}/routes/0`,
      "PUT",
      route
    );
  }

  async unpublish(claim: Pick<RouteClaim, "hostname" | "owner">): Promise<void> {
    await this.request(`/id/${Caddy.getRouteId(claim)}`, "DELETE", undefined, true);
  }

  getState(): CaddyState {
    if (!this.server || !this.origin) {
      throw new Error("Caddy is not ready");
    }
    return {
      data: {
        admin: this.admin,
        origin: this.origin,
        server: this.server,
      },
      provider: this.id,
    };
  }
}
