import { createTempDir } from "@tests/helpers";
import { createProvider } from "@tests/proxy/helpers";
import { describe, expect, it } from "vitest";

import { Endpoints } from "@/endpoints/resolve";
import { Resolver } from "@/env/resolve";

describe("endpoints", () => {
  it("generates root and named endpoint URLs before user environment resolution", async () => {
    const context = new Resolver({}, await createTempDir(), {
      allocator: { allocate: async () => await Promise.resolve(43_001) },
    });

    const endpoints = await Endpoints.ports(
      { "my-api": "43002", web: { port: `\${port()}`, root: true } },
      "project-12345678",
      context
    );

    const resolved = await Endpoints.urls(endpoints, createProvider(), context);
    expect(resolved).toStrictEqual({
      "my-api": {
        hostname: "my-api.project-12345678.localhost",
        port: 43_002,
        url: "https://my-api.project-12345678.localhost",
      },
      web: {
        hostname: "project-12345678.localhost",
        port: 43_001,
        url: "https://project-12345678.localhost",
      },
    });
    await context.resolve({ BACKEND: `\${env('MY_API_URL')}` });
    expect(context.env.WEB_URL).toBe("https://project-12345678.localhost");
    expect(context.env.BACKEND).toBe("https://my-api.project-12345678.localhost");
    expect(context.env.MY_API_PORT).toBe("43002");
  });

  it.each(["0", "65536", "x", "12.5", "127.0.0.1:12", ""])(
    "rejects invalid endpoint ports: %s",
    async (port) => {
      const context = new Resolver({}, await createTempDir());
      await expect(Endpoints.ports({ web: port }, "project", context)).rejects.toThrow(
        "Invalid port for endpoint web"
      );
    }
  );
});
