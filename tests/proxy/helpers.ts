import type { Provider } from "@/proxy/types";

export function createProvider(id = "test", overrides: Partial<Provider> = {}): Provider {
  return {
    ensureReady: async () => {
      await Promise.resolve();
    },
    getEndpointUrl: async (host) => await Promise.resolve(`https://${host}`),
    getState: () => ({ data: {}, provider: "portless" }),
    id,
    isAvailable: async () => await Promise.resolve(true),
    publish: async () => {
      await Promise.resolve();
    },
    unpublish: async () => {
      await Promise.resolve();
    },
    ...overrides,
  };
}
