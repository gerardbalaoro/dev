import path from "node:path";

import { createTempDir } from "@tests/helpers";
import { createCaddy } from "@tests/proxy/caddy-fixture";
import { describe, expect, it } from "vitest";

import { Caddy } from "@/proxy/caddy";
import { Routes } from "@/proxy/routes";

describe("route claims", () => {
  it("keeps a competing session and stale cleanup from replacing or removing the owner", async () => {
    const state = await createTempDir();
    const directory = path.join(state, "routes");
    const fixture = await createCaddy();

    const provider = new Caddy({
      admin: fixture.admin,
      env: { DEV_STATE_DIR: state },
    });

    const first = {
      hostname: "project.localhost",
      owner: "first",
      port: 43_101,
      root: "/first",
    };

    const second = {
      hostname: "project.localhost",
      owner: "second",
      port: 43_102,
      root: "/second",
    };

    try {
      await provider.ensureReady();
      await new Routes(directory).publish(first, provider);
      await expect(new Routes(directory).publish(second, provider)).rejects.toThrow(
        "already claimed"
      );
      await new Routes(directory).remove(second, provider);
      expect(fixture.routes).toMatchObject([
        {
          handle: [{ upstreams: [{ dial: "127.0.0.1:43101" }] }],
        },
      ]);
      await new Routes(directory).remove(first, provider);
      await new Routes(directory).publish(second, provider);
      await new Routes(directory).remove(first, provider);
      expect(fixture.routes).toHaveLength(1);
      expect(fixture.routes[0]).toMatchObject({
        handle: [{ upstreams: [{ dial: "127.0.0.1:43102" }] }],
      });
      await new Routes(directory).remove(second, provider);
      expect(fixture.routes).toStrictEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("allows only one concurrent claim and keeps its route after the loser's cleanup", async () => {
    const state = await createTempDir();
    const fixture = await createCaddy();

    const provider = new Caddy({
      admin: fixture.admin,
      env: { DEV_STATE_DIR: state },
    });

    const registry = new Routes(path.join(state, "routes"));

    const first = {
      hostname: "project.localhost",
      owner: "first",
      port: 43_101,
      root: "/first",
    };

    const second = {
      hostname: "project.localhost",
      owner: "second",
      port: 43_102,
      root: "/second",
    };

    try {
      await provider.ensureReady();

      const results = await Promise.allSettled([
        registry.publish(first, provider),
        registry.publish(second, provider),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const winner = results[0]?.status === "fulfilled" ? first : second;
      const loser = results[0]?.status === "fulfilled" ? second : first;
      await registry.remove(loser, provider);
      expect(fixture.routes).toHaveLength(1);
      await registry.remove(winner, provider);
      expect(fixture.routes).toStrictEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
