import { createTempDir } from "@tests/helpers";
import { createCaddy } from "@tests/proxy/caddy-fixture";
import { describe, expect, it, vi } from "vitest";

import { Caddy } from "@/proxy/caddy";
import { restore } from "@/proxy/detect";

describe("caddy", () => {
  it("rejects an existing proxy listener that conflicts with an application port", async () => {
    const fixture = await createCaddy();
    try {
      const provider = new Caddy({
        admin: fixture.admin,
        applicationPorts: [8080],
        env: { DEV_STATE_DIR: await createTempDir() },
      });
      await expect(provider.ensureReady()).rejects.toThrow("application port");
      expect(fixture.routes).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("mutates only owned routes, preserves other workspaces, and cleans by stable ID", async () => {
    const fixture = await createCaddy();
    try {
      const provider = new Caddy({
        admin: fixture.admin,
        env: { DEV_STATE_DIR: await createTempDir() },
      });
      await expect(provider.isAvailable()).resolves.toBeTruthy();
      await provider.ensureReady();
      await expect(provider.getEndpointUrl("api.project.localhost")).resolves.toBe(
        "http://api.project.localhost:8080"
      );
      await provider.publish({
        hostname: "api.project.localhost",
        owner: "test-session",
        port: 43_100,
        root: ".",
      });
      await provider.publish({
        hostname: "api.other.localhost",
        owner: "test-session",
        port: 43_101,
        root: ".",
      });
      await provider.publish({
        hostname: "api.project.localhost",
        owner: "test-session",
        port: 43_102,
        root: ".",
      });
      expect(fixture.routes).toHaveLength(2);
      expect(JSON.stringify(fixture.routes)).toContain("127.0.0.1:43102");
      vi.stubEnv("CADDY_ADMIN", "http://127.0.0.1:1");
      const restored = restore(provider.getState(), ".");
      await restored.unpublish({
        hostname: "api.project.localhost",
        owner: "test-session",
      });
      await restored.unpublish({
        hostname: "api.project.localhost",
        owner: "test-session",
      });
      expect(fixture.routes).toMatchObject([{ match: [{ host: ["api.other.localhost"] }] }]);
    } finally {
      vi.unstubAllEnvs();
      await fixture.close();
    }
  });

  it.each([
    {
      automatic_https: { disable: true },
      listen: [":80"],
      want: "http://api.project.localhost",
    },
    {
      automatic_https: { disable: true },
      listen: ["127.0.0.1:8080"],
      want: "http://api.project.localhost:8080",
    },
    {
      listen: ["[::1]:443"],
      tls_connection_policies: [{}],
      want: "https://api.project.localhost",
    },
    {
      listen: [":8443"],
      tls_connection_policies: [{}],
      want: "https://api.project.localhost:8443",
    },
  ])("derives the URL from the server listener: $want", async ({ want, ...server }) => {
    const fixture = await createCaddy({
      dev: { ...server, read_timeout: 5_000_000_000, routes: [] },
    });
    try {
      const provider = new Caddy({
        admin: fixture.admin,
        env: { DEV_STATE_DIR: await createTempDir() },
      });
      await provider.ensureReady();
      await expect(provider.getEndpointUrl("api.project.localhost")).resolves.toBe(want);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    { automatic_https: { disable: "true" }, listen: [":8080"], routes: [] },
    { listen: [":443"], routes: [], tls_connection_policies: "enabled" },
    { listen: [":443"], routes: [], tls_connection_policies: ["enabled"] },
    { automatic_https: { disable: true }, listen: [":8080"] },
    {
      automatic_https: { disable: true },
      listen: [":8080", ":8081"],
      routes: [],
    },
    {
      automatic_https: { disable: true },
      listen: ["192.0.2.1:8080"],
      routes: [],
    },
    { automatic_https: { disable: true }, listen: [":0"], routes: [] },
    { automatic_https: { disable: true }, listen: [":65536"], routes: [] },
    { listen: [":8080"], routes: [] },
    null,
  ])("rejects an incompatible dev server before publishing: %j", async (server) => {
    const fixture = await createCaddy({ dev: server });
    try {
      const provider = new Caddy({
        admin: fixture.admin,
        env: { DEV_STATE_DIR: await createTempDir() },
      });
      await expect(provider.ensureReady()).rejects.toThrow(/Caddy/u);
      await expect(
        provider.publish({
          hostname: "api.project.localhost",
          owner: "test-session",
          port: 43_100,
          root: ".",
        })
      ).rejects.toThrow("not ready");
      expect(fixture.routes).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
});
