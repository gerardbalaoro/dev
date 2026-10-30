import { once } from "node:events";
import { connect } from "node:net";

import { inherit } from "@/env/resolve";
import { run } from "@/process/run";
import type { Provider, PortlessState, RouteClaim } from "@/proxy/types";

export type Runner = (args: string[]) => Promise<string>;
interface PortlessOptions {
  applicationPorts?: number[];
  runner?: Runner;
  state?: PortlessState;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export class Portless implements Provider {
  private readonly options: PortlessOptions;

  private readonly cwd: string;

  readonly id = "portless";
  private origin?: URL;
  private readonly env: Record<string, string>;
  constructor(cwd: string, options: PortlessOptions = {}) {
    this.options = options;

    this.cwd = cwd;

    this.env = {
      ...Object.fromEntries(
        Object.entries(options.env ?? inherit()).filter(
          ([key]) => !options.state || !key.startsWith("PORTLESS_")
        )
      ),
      ...options.state?.data,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
  }

  private async run(args: string[]): Promise<string> {
    if (this.options.runner) {
      return await this.options.runner(args);
    }
    const timeout = AbortSignal.timeout(15_000);
    const result = await run(["portless", ...args], {
      cwd: this.cwd,
      env: this.env,
      shouldCapture: true,
      signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
    });
    if (result.code) {
      throw new Error(`Portless ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureReady(): Promise<void> {
    await this.run(["proxy", "start"]);
    const url = await this.getUrl("dev-provider-probe.localhost");
    if (
      this.options.applicationPorts?.includes(
        Number(url.port || (url.protocol === "https:" ? 443 : 80))
      ) === true
    ) {
      throw new Error("Portless listener conflicts with an application port");
    }
    const socket = connect({
      host: "127.0.0.1",
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    const timeout = AbortSignal.timeout(2000);
    try {
      await once(socket, "connect", { signal: timeout });
    } catch (error) {
      if (timeout.aborted) {
        throw new Error("Portless proxy is not listening", { cause: error });
      }
      throw error;
    } finally {
      socket.destroy();
    }
    this.origin = url;
  }

  private async getUrl(hostname: string): Promise<URL> {
    const url = new URL(await this.run(["get", Portless.getAlias(hostname), "--no-worktree"]));
    if (url.hostname !== hostname || !["http:", "https:"].includes(url.protocol)) {
      throw new Error(
        "Portless must serve the logical .localhost hostname (LAN/custom-only TLD mode is incompatible)"
      );
    }
    return url;
  }

  private static getAlias(hostname: string): string {
    if (!hostname.endsWith(".localhost")) {
      throw new Error("Expected a .localhost hostname");
    }
    return hostname.slice(0, -".localhost".length);
  }

  async getEndpointUrl(hostname: string): Promise<string> {
    const url = this.origin ? new URL(this.origin) : await this.getUrl(hostname);
    url.hostname = hostname;
    return url.origin;
  }

  async publish({ hostname, port }: RouteClaim): Promise<void> {
    await this.run(["alias", Portless.getAlias(hostname), String(port)]);
  }

  async unpublish({ hostname }: Pick<RouteClaim, "hostname" | "owner">): Promise<void> {
    try {
      await this.run(["alias", "--remove", Portless.getAlias(hostname)]);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("No alias found for"))) {
        throw error;
      }
    }
  }

  getState(): PortlessState {
    return {
      data: Object.fromEntries(
        Object.entries(this.env).filter(([key]) => key.startsWith("PORTLESS_"))
      ),
      provider: this.id,
    };
  }
}
