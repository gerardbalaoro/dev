import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createTempDir } from "@tests/helpers";
import { describe, expect, it } from "vitest";

import { docker } from "@/env/helpers";
import { inherit, Resolver } from "@/env/resolve";

describe("docker-compose", () => {
  const publisher = {
    Protocol: "tcp",
    PublishedPort: 49_152,
    TargetPort: 5432,
    URL: "0.0.0.0",
  };

  const container = {
    Command: "docker-entrypoint.sh postgres",
    ExitCode: 0,
    Health: "",
    ID: "f02a4efaabb67416e1ff127d51c4b5578634a0ad5743bd65225ff7d1909a3fa0",
    Name: "project-worktree-postgres-1",
    Project: "project-worktree",
    Publishers: [publisher],
    Service: "postgres",
    State: "running",
  };

  async function createDocker(output = JSON.stringify(container)) {
    const root = await createTempDir();
    await writeFile(
      path.join(root, "docker"),
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync("docker-call.json", JSON.stringify({
  args: process.argv.slice(2),
  workspace: process.env.WORKSPACE_NAME,
  project: process.env.COMPOSE_PROJECT_NAME,
  previous: process.env.PREVIOUS,
}));
if (process.env.DOCKER_TEST_HANG) setInterval(() => {}, 1000);
else if (process.env.DOCKER_TEST_FAIL) {
  process.stderr.write("service is not running");
  process.exitCode = 1;
} else process.stdout.write(process.env.DOCKER_TEST_OUTPUT);
`,
      { mode: 0o755 }
    );
    const env = {
      ...inherit(),
      COMPOSE_PROJECT_NAME: "project-worktree",
      DOCKER_TEST_OUTPUT: output,
      PATH: `${root}${path.delimiter}${process.env.PATH}`,
      WORKSPACE_NAME: "project-worktree",
    };
    return { env, root };
  }

  it.each([["0.0.0.0"], ["::"], ["0.0.0.0", "::"]])(
    "resolves Compose JSON publishers with addresses %j",
    async (...addresses) => {
      const output = JSON.stringify({
        ...container,
        Publishers: addresses.map((URL) => ({ ...publisher, URL })),
      });
      const { root, env } = await createDocker(output);
      const context = new Resolver(env, root);
      await context.resolve(
        Object.fromEntries([
          ["PREVIOUS", "already-resolved"],
          ["POSTGRES_PORT", `\${docker.compose.port('postgres', 5432)}`],
          [
            "DATABASE_URL",
            `postgresql://localhost:\${env('POSTGRES_PORT')}/app`,
          ],
        ])
      );
      expect(context.resolved.DATABASE_URL).toBe(
        "postgresql://localhost:49152/app"
      );
      expect(
        JSON.parse(await readFile(path.join(root, "docker-call.json"), "utf-8"))
      ).toStrictEqual({
        args: [
          "compose",
          "ps",
          "--format",
          "json",
          "--status",
          "running",
          "postgres",
        ],
        previous: "already-resolved",
        project: "project-worktree",
        workspace: "project-worktree",
      });
    }
  );

  it("supports deferred Docker helpers inside interpolated URLs", async () => {
    const { root, env } = await createDocker(
      JSON.stringify({
        ...container,
        Command: "/mailpit",
        Name: "project-worktree-mail-pit-1",
        Publishers: [{ ...publisher, TargetPort: 8025 }],
        Service: "mail-pit",
      })
    );
    const context = new Resolver(env, root);
    await expect(
      context.resolveValue(
        `http://localhost:${docker.port("mail-pit", 8025)}/inbox`
      )
    ).resolves.toBe("http://localhost:49152/inbox");
    expect(
      JSON.parse(await readFile(path.join(root, "docker-call.json"), "utf-8"))
    ).toMatchObject({
      args: [
        "compose",
        "ps",
        "--format",
        "json",
        "--status",
        "running",
        "mail-pit",
      ],
    });
  });

  it.each([
    `\${docker.compose.port('postgres')}`,
    `\${docker.compose.port('postgres', 0)}`,
    `\${docker.compose.port('postgres', 65536)}`,
    `\${docker.compose.port('-x', 5432)}`,
    `\${docker.compose.port('postgres;touch hacked', 5432)}`,
    `\${docker.compose.port('postgres', 5432}`,
    `\${docker.compose.ports('postgres', 5432)}`,
    `\${docker.compose.port('postgres', '5432')}`,
  ])(
    "rejects invalid arguments without executing Docker: %s",
    async (expression) => {
      const { root, env } = await createDocker();
      const context = new Resolver(env, root);
      await expect(context.resolveValue(expression)).rejects.toThrow(
        /too_small|too_big|invalid_format|invalid_type|Unexpected token|Template evaluation failed/u
      );
      await expect(
        readFile(path.join(root, "docker-call.json"))
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  );

  it("reports Docker command failures", async () => {
    const { root, env } = await createDocker();
    const failing = new Resolver({ ...env, DOCKER_TEST_FAIL: "1" }, root);
    await expect(
      failing.resolveValue(`\${docker.compose.port('postgres', 5432)}`)
    ).rejects.toThrow("service is not running");
  });

  it("selects only the requested TCP port across JSON Lines", async () => {
    const { root, env } = await createDocker(
      [
        { ...container, Publishers: null },
        {
          ...container,
          Publishers: [
            { ...publisher, Protocol: "udp", PublishedPort: 50_000 },
            { ...publisher, PublishedPort: 50_001, TargetPort: 80 },
            publisher,
          ],
        },
        { ...container, Publishers: [{ ...publisher, URL: "::" }] },
      ]
        .map((row, index) =>
          JSON.stringify({
            ...row,
            ID: String(index + 1).padStart(64, "0"),
            Name: `project-worktree-postgres-${index + 1}`,
          })
        )
        .join("\n")
    );
    const context = new Resolver(env, root);
    await expect(
      context.resolveValue(`\${docker.compose.port('postgres', 5432)}`)
    ).resolves.toBe("49152");
  });

  it.each([
    ["", "found 0"],
    [JSON.stringify({ ...container, Publishers: null }), "found 0"],
    [JSON.stringify({ ...container, Publishers: [] }), "found 0"],
    [
      JSON.stringify({
        ...container,
        Publishers: [{ ...publisher, PublishedPort: 0 }],
      }),
      "found 0",
    ],
    [
      JSON.stringify({
        ...container,
        Publishers: [{ ...publisher, Protocol: "udp" }],
      }),
      "found 0",
    ],
    [
      JSON.stringify({
        ...container,
        Publishers: [{ ...publisher, TargetPort: 80 }],
      }),
      "found 0",
    ],
    [
      [publisher, { ...publisher, PublishedPort: 49_153 }]
        .map((binding, index) =>
          JSON.stringify({
            ...container,
            ID: String(index + 1).padStart(64, "0"),
            Name: `project-worktree-postgres-${index + 1}`,
            Publishers: [binding],
          })
        )
        .join("\n"),
      "found 2",
    ],
  ])(
    "rejects missing or ambiguous published ports: %s",
    async (output, error) => {
      const { root, env } = await createDocker(output);
      const context = new Resolver(env, root);
      await expect(
        context.resolveValue(`\${docker.compose.port('postgres', 5432)}`)
      ).rejects.toThrow(error);
    }
  );

  it.each([
    "not json",
    JSON.stringify({
      ...container,
      Publishers: [{ ...publisher, PublishedPort: "49152" }],
    }),
    JSON.stringify({
      ...container,
      Publishers: [{ ...publisher, PublishedPort: 65_536 }],
    }),
  ])("rejects invalid Compose JSON: %s", async (output) => {
    const { root, env } = await createDocker(output);
    const context = new Resolver(env, root);
    await expect(
      context.resolveValue(`\${docker.compose.port('postgres', 5432)}`)
    ).rejects.toThrow(/JSON|Unexpected|Invalid|Too big/u);
  });

  it("can cancel a stuck Docker command through normal process supervision", async () => {
    const { root, env } = await createDocker();
    const controller = new AbortController();
    const context = new Resolver({ ...env, DOCKER_TEST_HANG: "1" }, root, {
      signal: controller.signal,
    });
    const lookup = context.resolveValue(
      `\${docker.compose.port('postgres', 5432)}`
    );
    const cancel = (async () => {
      try {
        await expect
          .poll(async () => {
            try {
              await readFile(path.join(root, "docker-call.json"));
              return true;
            } catch {
              return false;
            }
          })
          .toBeTruthy();
      } finally {
        controller.abort();
      }
    })();
    await Promise.all([
      expect(lookup).rejects.toThrow("Docker Compose port lookup failed"),
      cancel,
    ]);
  }, 7000);
});
