import { realpath } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";

import { name as label } from "@/workspace/name";

export interface GitWorkspace {
  root: string;
  gitDir: string;
  commonDir: string;
  isLinked: boolean;
}

export interface Workspace extends GitWorkspace {
  name: string;
  project: string;
}

async function git(cwd = process.cwd()): Promise<GitWorkspace> {
  const query = async (flag: string) => {
    const { stdout } = await execa("git", ["rev-parse", flag], { cwd });

    return stdout.trim();
  };

  try {
    const [root, gitDir, commonDir] = await Promise.all([
      query("--show-toplevel"),
      query("--git-dir"),
      query("--git-common-dir"),
    ]);

    const [canonicalRoot, canonicalGit, canonicalCommon] = await Promise.all([
      realpath(path.resolve(cwd, root)),
      realpath(path.resolve(cwd, gitDir)),
      realpath(path.resolve(cwd, commonDir)),
    ]);

    return {
      commonDir: canonicalCommon,
      gitDir: canonicalGit,
      isLinked: canonicalGit !== canonicalCommon,
      root: canonicalRoot,
    };
  } catch (error) {
    throw new Error("Run dev inside a Git working tree.", { cause: error });
  }
}

function name(project: string, checkout: GitWorkspace): Workspace {
  return {
    ...checkout,
    name: label(project, checkout.root, checkout.isLinked),
    project,
  };
}

async function resolve(project: string, cwd = process.cwd()): Promise<Workspace> {
  return name(project, await git(cwd));
}

export const Workspaces = { git, name, resolve };
