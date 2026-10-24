import terminalLink from "terminal-link";

import type { Endpoints } from "@/endpoints/types";

export function format(endpoints: Endpoints): string {
  return Object.entries(endpoints)
    .map(
      ([name, endpoint]) =>
        `  ${name.padEnd(12)} ${terminalLink(endpoint.url, endpoint.url, { fallback: false })}\n  ${"".padEnd(12)} → localhost:${endpoint.port}`
    )
    .join("\n");
}
