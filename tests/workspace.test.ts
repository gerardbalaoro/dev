import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";

import { createGitRepo, createTempDir } from "@tests/helpers";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { name as label } from "@/workspace/name";
import { Workspaces } from "@/workspace/resolve";

describe("workspace", () => {
  it("uses Git semantics for main checkouts, nested directories, and linked worktrees", async () => {
    const root = await createGitRepo();
    await mkdir(path.join(root, "nested"));
    const main = await Workspaces.resolve("project", path.join(root, "nested"));
    expect(main).toMatchObject({ isLinked: false, name: "project" });
    const worktree = path.join(await createTempDir(), "feature");
    await execa("git", ["-C", root, "worktree", "add", "-qb", "feature", worktree]);
    const linked = await Workspaces.resolve("project", worktree);
    expect(linked).toMatchObject({
      isLinked: true,
      name: expect.stringMatching(/^project-[a-f0-9]{8}$/u),
    });
    const workspace = await Workspaces.resolve("project", worktree);
    expect(linked.name).toBe(workspace.name);
    const other = path.join(await createTempDir(), "other");
    await execa("git", ["-C", root, "worktree", "add", "-qb", "other", other]);
    const otherWorkspace = await Workspaces.resolve("project", other);
    expect(otherWorkspace.name).not.toBe(linked.name);
    const alias = path.join(await createTempDir(), "alias");
    await symlink(worktree, alias);
    const workspace2 = await Workspaces.resolve("project", alias);
    expect(workspace2.name).toBe(linked.name);
  });

  it("rejects non-Git directories", async () => {
    await expect(Workspaces.resolve("project", await createTempDir())).rejects.toThrow(
      "Git working tree"
    );
  });

  it("a main checkout with a separate Git directory remains the main checkout", async () => {
    const parent = await createTempDir();
    const root = path.join(parent, "repo");
    await execa("git", ["init", "-q", "--separate-git-dir", path.join(parent, "metadata"), root]);
    const workspace = await Workspaces.resolve("project", root);
    expect(workspace.name).toBe("project");
  });

  it.each([
    { root: "/work/project/feature-a", want: "project-f86c5220" },
    { root: "/work/project/feature-b", want: "project-3c30cd5a" },
  ])("derives a worktree name from its canonical root: $root", ({ root, want }) => {
    expect(label("project", root, true)).toBe(want);
  });
});
