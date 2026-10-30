/* oxlint-disable typescript/prefer-promise-reject-errors -- Exercise providers that reject with non-Error values. */
import { setImmediate } from "node:timers/promises";

import { createProvider } from "@tests/proxy/helpers";
import { describe, expect, it, vi } from "vitest";

import { detect } from "@/proxy/detect";

describe("proxy detection", () => {
  it("prefers Portless and waits for readiness without preparing another provider", async () => {
    let isReady = false;
    const portless = createProvider("portless", {
      ensureReady: async () => {
        await setImmediate();
        isReady = true;
      },
    });
    const caddy = createProvider("caddy", {
      isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    });
    const provider = await detect(".", {
      providers: [portless, caddy],
    });
    expect(provider.id).toBe("portless");
    expect(isReady).toBeTruthy();
    expect(caddy.isAvailable).not.toHaveBeenCalled();
  });

  it("falls back when preferred provider is installed but unusable", async () => {
    const provider = await detect(".", {
      providers: [
        createProvider("portless", {
          ensureReady: async () => {
            await Promise.reject(new Error("not ready"));
          },
        }),
        createProvider("caddy"),
      ],
    });
    expect(provider.id).toBe("caddy");
  });

  it("fails with actionable diagnostics without a provider", async () => {
    await expect(
      detect(".", {
        providers: [
          createProvider("test", { isAvailable: async () => await Promise.resolve(false) }),
        ],
      })
    ).rejects.toThrow("Install Portless");
  });

  it.each([
    { error: null, want: "portless: null" },
    { error: undefined, want: "portless: undefined" },
    { error: "connection refused", want: "portless: connection refused" },
  ])(
    "falls back after a provider rejects with a non-Error value: $error",
    async ({ error, want }) => {
      const failed = createProvider("portless", {
        ensureReady: async () => {
          await Promise.reject(error);
        },
      });
      const provider = await detect(".", {
        providers: [failed, createProvider("caddy")],
      });
      expect(provider.id).toBe("caddy");
      await expect(detect(".", { providers: [failed] })).rejects.toThrow(want);
    }
  );
});
