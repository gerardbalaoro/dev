import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach } from "vitest";

export type FixtureValue =
  | string
  | number
  | boolean
  | null
  | FixtureValue[]
  | { [key: string]: FixtureValue | undefined };

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(async (dir) => {
      await rm(dir, { force: true, recursive: true });
    })
  );
});
export async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "dev-test-"));
  temporary.push(directory);
  return directory;
}

export async function createGitRepo(): Promise<string> {
  const root = await createTempDir();
  await execa("git", ["init", "-q", root]);
  await execa("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  return root;
}

export async function writeConfig(root: string, config: FixtureValue): Promise<void> {
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dev: config }));
}
