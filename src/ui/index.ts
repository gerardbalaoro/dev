import { intro, log, note } from "@clack/prompts";

import type { Endpoints } from "@/endpoints/types";
import { output } from "@/ui/command";
import { format } from "@/ui/endpoints";
import type { Output } from "@/ui/follow";

export interface UI {
  start: (workspace: string) => void;
  output: (command: string, lines: number) => Output;
  showEndpoints: (endpoints: Endpoints) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

export const UI: UI = {
  error: (message) => {
    log.error(message);
  },
  info: (message) => {
    log.info(message);
  },
  output,
  showEndpoints: (endpoints) => {
    if (Object.keys(endpoints).length) {
      note(format(endpoints), "Local URLs");
    }
  },
  start: (workspace) => {
    intro(`dev · ${workspace}`);
  },
};
