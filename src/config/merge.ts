import type { Extension } from "@/config/types";

export function merge(base: Extension, extension: Extension): Extension {
  const patch = Object.fromEntries(
    Object.entries(extension).filter(([, value]) => value !== undefined)
  );

  const result: Extension = { ...base, ...patch };

  if (extension.env !== undefined) {
    result.env = { ...base.env, ...extension.env };
  }

  if (extension.endpoints !== undefined) {
    result.endpoints = { ...base.endpoints, ...extension.endpoints };
  }

  if (extension.hooks !== undefined) {
    result.hooks = { ...base.hooks, ...extension.hooks };
  }

  return result;
}
