import type { Provider } from "@/proxy/types";

export function createProvider(id = "test", overrides: Partial<Provider> = {}): Provider {
  return {
    ensureReady: () => Promise.resolve(),
    getEndpointUrl: (host) => Promise.resolve(`https://${host}`),
    getState: () => ({ data: {}, provider: "portless" }),
    id,
    isAvailable: () => Promise.resolve(true),
    publish: () => Promise.resolve(),
    unpublish: () => Promise.resolve(),
    ...overrides,
  };
}
