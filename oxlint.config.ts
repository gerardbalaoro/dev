import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest, antiSlop],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: ["src/dev.ts"],
      rules: {
        // Dispatch the public string/function overload without wrapping the callback.
        "anti-slop/no-runtime-typeof": "off",
        // Nested cleanup errors need distinct names to preserve both failures.
        "unicorn/catch-error-name": "off",
      },
    },
    {
      files: ["src/session/connect.ts", "src/session/launch.ts"],
      rules: {
        // Observe completion without blocking startup; IPC uses Node callbacks.
        "promise/prefer-await-to-callbacks": "off",
        "promise/prefer-await-to-then": "off",
      },
    },
  ],
  rules: {
    "eslint/func-style": ["error", "declaration", { allowArrowFunctions: true }],
    // TypeScript checks duplicate declarations and allows separate type/value names.
    "eslint/no-redeclare": "off",
  },
});
