import { isTTY, log, taskLog } from "@clack/prompts";

import { Tail } from "@/ui/follow";
import type { Output } from "@/ui/follow";

export function output(text: string, lines: number): Output {
  const tail = new Tail();
  const live = isTTY(process.stdout)
    ? taskLog({ limit: lines, retainLog: false, title: `$ ${text}` })
    : undefined;

  if (!live) {
    log.step(`$ ${text}`);
  }

  return {
    finish(code) {
      if (code === 0) {
        if (live) {
          live.success("Command completed");
        } else {
          log.success("Command completed");
        }
        return;
      }

      const message = `Command exited with code ${code}\n${tail.getLines(30).join("\n")}`;
      if (live) {
        live.error(message, { showLog: false });
      } else {
        log.error(message);
      }
    },
    write(chunk) {
      if (!live) {
        process.stdout.write(chunk);
        return;
      }
      const completed = tail.write(chunk);
      if (completed.length) {
        live?.message(completed.join("\n"));
      }
    },
  };
}
