export function hostname(name: string, workspace: string, isRoot = false): string {
  return `${isRoot ? "" : `${name}.`}${workspace}.localhost`;
}

export const prefix = (name: string): string => name.toUpperCase().replaceAll("-", "_");
