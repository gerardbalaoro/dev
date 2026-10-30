import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeConfig, createTempDir } from "@tests/helpers";
import { describe, expect, it } from "vitest";

import { load } from "@/config/load";
import { ConfigSchema } from "@/config/schema";

const base = { name: "project", run: "echo hello" };

describe("configuration", () => {
  it("does not inherit commands from a package outside the workspace", async () => {
    const parent = await createTempDir();
    const root = path.join(parent, "child");
    await mkdir(root);
    await writeConfig(parent, { name: "parent", run: "echo wrong" });
    await expect(load(root)).rejects.toThrow("Invalid dev configuration");
    await writeFile(path.join(root, "dev.config.json"), JSON.stringify(base));
    await expect(load(root)).resolves.toMatchObject(base);
  });

  it("loads package.json and merges conventional config with c12 precedence", async () => {
    const root = await createTempDir();
    await writeConfig(root, { ...base, env: { ONE: "one", TWO: "old" } });
    await writeFile(path.join(root, "dev.config.ts"), 'export default { env: { TWO: "two" } }');
    const config2 = await load(root);
    expect(config2.env).toStrictEqual({ ONE: "one", TWO: "two" });
  });

  it("merges programmatic extensions by key and replaces complete endpoint definitions", async () => {
    const root = await createTempDir();
    await writeConfig(root, {
      endpoints: { api: "4001", web: { port: "4000", root: true } },
      env: { BASE: "base", MODE: "old" },
      hooks: { bootstrap: "old", shutdown: "keep" },
      name: "project",
    });

    const config = await load(root, {
      endpoints: { web: "5000" },
      env: { MODE: "new" },
      hooks: { bootstrap: "new" },
      run: "echo configured",
    });

    expect(config).toStrictEqual({
      endpoints: { api: "4001", web: "5000" },
      env: { BASE: "base", MODE: "new" },
      hooks: { bootstrap: "new", shutdown: "keep" },
      name: "project",
      run: "echo configured",
    });
    await expect(load(root, { env: { WEB_PORT: "unsafe" }, run: "true" })).rejects.toThrow(
      "generated and cannot be overridden"
    );
  });

  it.each([
    {
      body: 'module.exports = { name: "project", run: "echo hello" }',
      extension: "js",
    },
    { body: '{ "name": "project", "run": "echo hello" }', extension: "json" },
    {
      body: '{ // config\n "name": "project", "run": "echo hello", }',
      extension: "jsonc",
    },
  ])("loads dev.config.$extension", async ({ extension, body }) => {
    const root = await createTempDir();
    await writeFile(path.join(root, `dev.config.${extension}`), body);
    const config2 = await load(root);
    expect(config2.name).toBe("project");
  });

  it.each([
    { proxy: "caddy" },
    { name: "../escape" },
    { name: "UPPERCASE" },
    {
      endpoints: {
        a: { port: `\${port()}`, root: true },
        b: { port: "1234", root: true },
      },
    },
    { endpoints: { api: `\${port()}` }, env: { API_URL: "override" } },
    { env: { COMPOSE_PROJECT_NAME: "override" } },
    { hooks: { unknown: "true" } },
    { endpoints: { api: { port: 1234 } } },
  ])("rejects invalid or conflicting fields: %j", (override) => {
    expect(ConfigSchema.safeParse({ ...base, ...override }).success).toBeFalsy();
  });
});
