import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";

import { HostnameClaimSchema } from "@/proxy/types";
import type { Provider, RouteClaim, HostnameClaim } from "@/proxy/types";
import { hash } from "@/utils/hash";

// Durable claims outlive the lock and the CLI. Only the claiming session may release them.
export class Routes {
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  private async withClaim(
    claim: HostnameClaim,
    action: (file: string, current: HostnameClaim | undefined) => Promise<void>
  ): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    const file = path.join(this.directory, `${hash(claim.hostname)}.json`);

    const release = await lockfile.lock(file, {
      realpath: false,
      retries: { factor: 1, maxTimeout: 1000, minTimeout: 1000, retries: 7 },
      stale: 5000,
      update: 1000,
    });

    try {
      const current = await (async (): Promise<HostnameClaim | undefined> => {
        try {
          return HostnameClaimSchema.parse(JSON.parse(await readFile(file, "utf-8")));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
          }

          throw error;
        }
      })();

      await action(file, current);
    } finally {
      await release();
    }
  }

  private static async claim(
    file: string,
    current: HostnameClaim | undefined,
    claim: HostnameClaim
  ): Promise<void> {
    if (current && (current.owner !== claim.owner || current.root !== claim.root)) {
      throw new Error(
        `Hostname ${claim.hostname} is already claimed by ${current.root}. Stop that session before reusing the hostname.`
      );
    }

    if (!current) {
      const temporary = `${file}.${randomUUID()}.tmp`;

      try {
        await writeFile(temporary, JSON.stringify(claim), {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }

  async reserve(claim: HostnameClaim): Promise<void> {
    await this.withClaim(claim, async (file, current) => {
      await Routes.claim(file, current, claim);
    });
  }

  async publish(claim: RouteClaim, provider: Provider): Promise<void> {
    await this.withClaim(claim, async (file, current) => {
      await Routes.claim(file, current, claim);
      await provider.publish(claim);
    });
  }

  async remove(claim: HostnameClaim, provider?: Provider): Promise<void> {
    await this.withClaim(claim, async (file, current) => {
      if (!current || current.owner !== claim.owner || current.root !== claim.root) {
        return;
      }

      await provider?.unpublish(claim);
      await rm(file);
    });
  }
}
