import { readFile } from "node:fs/promises";
import path from "node:path";

import { createTempDir } from "@tests/helpers";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { interpolate } from "@/env/interpolate";
import { Resolver } from "@/env/resolve";

describe("environment expressions", () => {
  it.each([
    `\${exec('printf x >> calls; printf value').trim()}`,
    `\${exec('printf x >> calls')}\${port().toString()}`,
    `\${exec('printf x >> calls')}\${1 + 1}`,
  ])("rejects unsupported syntax before executing any shell command: %s", async (expression) => {
    const root = await createTempDir();
    const context = new Resolver({}, root);
    await expect(context.resolveValue(expression)).rejects.toThrow("Unsupported expression");
    await expect(readFile(path.join(root, "calls"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resolves once, in order, inheriting earlier values in commands", async () => {
    let calls = 0;

    const context = new Resolver({ BASE: "base" }, await createTempDir(), {
      allocator: {
        allocate: async () => {
          const port = 43_000 + calls;
          calls += 1;

          return await Promise.resolve(port);
        },
      },
    });

    await context.resolve(
      Object.fromEntries([
        ["PORT", `\${port()}`],
        ["COPY", `\${env('PORT')}-\${env('PORT')}`],
        ["COMMAND", `\${exec('printf "%s" "$COPY"')}`],
        ["URL", `http://localhost:\${env('PORT')}`],
      ])
    );
    expect(calls).toBe(1);
    expect({ ...context.resolved }).toStrictEqual({
      COMMAND: "43000-43000",
      COPY: "43000-43000",
      PORT: "43000",
      URL: "http://localhost:43000",
    });
    expect(context.resolved).not.toHaveProperty("BASE");
  });

  it("preserves trimmed command stdout and nested shell substitutions", async () => {
    const context = new Resolver({}, await createTempDir());
    await expect(context.resolveValue(`\${exec('printf "  hello  "')}`)).resolves.toBe("hello");
    await expect(context.resolveValue(`\${exec('printf "%s" "$(printf nested)"')}`)).resolves.toBe(
      "nested"
    );
    await expect(context.resolveValue(`\${exec('(printf parens)')}`)).resolves.toBe("parens");
  });

  it("rejects missing and forward environment references and command failures", async () => {
    const context = new Resolver({}, await createTempDir());
    await expect(context.resolve({ A: `\${env('B')}`, B: "later" })).rejects.toThrow(
      "not resolved"
    );
    await expect(context.resolveValue(`\${exec('exit 7')}`)).rejects.toThrow("exit 7");
  });

  it.each([`\${port(2)}`, `\${env()}`, `\${exec('')}`, `\${exec(42)}`])(
    "rejects invalid resolver arguments: %s",
    async (input) => {
      const context = new Resolver({}, await createTempDir());
      await expect(context.resolveValue(input)).rejects.toThrow(
        /too_big|too_small|invalid_type|custom/u
      );
    }
  );

  it("awaits nested context functions and preserves their output literally", async () => {
    await expect(
      interpolate(`some-string-\${double(port())}-\${env('TOKEN')}`, {
        double: async (value) => await Promise.resolve(z.number().parse(value) * 2),
        env: () => `x&y-\${port()}`,
        port: async () => await Promise.resolve(21),
      })
    ).resolves.toBe(`some-string-42-x&y-\${port()}`);
  });

  it("finishes each async interpolation before starting the next", async () => {
    let value = 0;

    const context = {
      advance: async () => {
        await Promise.resolve();
        value += 1;

        return value;
      },
      current: () => value,
    };

    await expect(interpolate(`\${advance()}-\${current()}-\${advance()}`, context)).resolves.toBe(
      "1-1-2"
    );
  });

  it.each([`\${missing()}`, `\${docker.compose.missing()}`, `\${value()}`])(
    "throws for invalid calls instead of returning undefined: %s",
    async (input) => {
      await expect(interpolate(input, {})).rejects.toThrow("Template evaluation failed");
    }
  );

  it("propagates errors from async context functions", async () => {
    const error = new Error("Port allocation failed");
    await expect(
      interpolate(`\${port()}`, {
        port: async () => await Promise.reject(error),
      })
    ).rejects.toBe(error);
  });

  it.each([`\${port(`, `\${port(}`, `\${port()}\` + \`ignored`, `\${port()}\`; 'ignored'`])(
    "rejects malformed or partially parsed templates: %s",
    async (input) => {
      let calls = 0;
      await expect(
        interpolate(input, {
          port: () => {
            calls += 1;

            return calls;
          },
        })
      ).rejects.toThrow(SyntaxError);
      expect(calls).toBe(0);
    }
  );

  it("handles quoted braces and nested template literals", async () => {
    await expect(interpolate(`\${\`value-\${env('VALUE')}\`}`, { env: () => "}" })).resolves.toBe(
      "value-}"
    );
  });

  it("preserves plain strings and supports escaped literal interpolation", async () => {
    await expect(interpolate("C:\\new\\`files` & $HOME", {})).resolves.toBe(
      "C:\\new\\`files` & $HOME"
    );
    await expect(interpolate(`\\\${port()}`, {})).resolves.toBe(`\${port()}`);
  });
});
