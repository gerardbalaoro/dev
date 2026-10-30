import getPort from "get-port";

export interface Allocator {
  allocate: () => Promise<number>;
}

export function allocator(): Allocator {
  return {
    allocate: async () => await getPort({ host: "127.0.0.1", reserve: true }),
  };
}
