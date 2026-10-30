import { Store } from "@/session/store";
import { Workspaces } from "@/workspace/resolve";

export async function context(cwd = process.cwd()) {
  const git = await Workspaces.git(cwd);

  return { git, store: new Store(git) };
}
