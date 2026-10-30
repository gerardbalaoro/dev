import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createGitRepo, createTempDir } from "@tests/helpers";
import { describe, expect, it, vi } from "vitest";

import { inherit } from "@/env/resolve";
import { Identity } from "@/process/identity";
import { Execution } from "@/session/execution";
import { Journal } from "@/session/lifecycle";
import { Store } from "@/session/store";
import { UI } from "@/ui/index";
import { Workspaces } from "@/workspace/resolve";

const Silent: UI = {
  ...UI,
  output: () => ({ finish() {}, write() {} }),
};

describe("session execution", () => {
  it("refuses overlapping serial execution without erasing the active process record", async () => {
    const workspace = await Workspaces.resolve("project", await createGitRepo());
    const store = new Store(workspace, await createTempDir());
    const journal = await Journal.create(workspace, store);
    const execution = new Execution(journal);
    const options = { cwd: workspace.root, env: inherit() };
    await writeFile(path.join(workspace.root, "run.cjs"), "setInterval(() => {}, 1000)");
    const application = await execution.start("node run.cjs", options, Silent);

    try {
      const before = await store.read();

      if (!before?.process) {
        throw new Error("Missing application process record");
      }

      await expect(
        execution.run(
          [process.execPath, "-e", 'require("node:fs").writeFileSync("unexpected", "spawned")'],
          options
        )
      ).rejects.toThrow("already active");
      const during = await store.read();
      expect(during?.process).toStrictEqual(before.process);
      await expect(readFile(path.join(workspace.root, "unexpected"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await execution.stop();
      await application.exited;
    }
  });

  it("rejects startup and terminates the child when ownership cannot be recorded", async () => {
    const workspace = await Workspaces.resolve("project", await createGitRepo());
    const store = new Store(workspace, await createTempDir());
    const journal = await Journal.create(workspace, store);
    const execution = new Execution(journal);
    await writeFile(path.join(workspace.root, "run.cjs"), "setInterval(() => {}, 1000)");
    const write = store.write.bind(store);
    let spawned: Identity | undefined;

    const recording = vi.spyOn(store, "write").mockImplementation(async (state) => {
      if (state.process) {
        spawned = state.process;
        throw new Error("Ownership record failed");
      }

      await write(state);
    });

    try {
      await expect(
        execution.start("node run.cjs", { cwd: workspace.root, env: inherit() }, Silent)
      ).rejects.toThrow("Ownership record failed");

      if (!spawned) {
        throw new Error("Missing spawned process identity");
      }

      await expect(Identity.matches(spawned)).resolves.toBeFalsy();
      const state = await store.read();
      expect(state?.process).toBeUndefined();
    } finally {
      await execution.stop();
      recording.mockRestore();

      if (spawned) {
        await Identity.stop(spawned);
      }
    }
  });
});
