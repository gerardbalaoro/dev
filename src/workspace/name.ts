import { hash } from "@/utils/hash";

export function name(project: string, root: string, isLinked: boolean): string {
  return isLinked ? `${project}-${hash(root).slice(0, 8)}` : project;
}
