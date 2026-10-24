import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { Tail } from "@/ui/follow";

describe("ui", () => {
  it("streams application output when stdout is redirected", async () => {
    const { stdout } = await execa(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { output } from './src/ui/command.ts'; const display = output('app', 8); display.write('application log\\npartial'); display.finish(0);",
    ]);
    expect(stdout).toContain("application log\npartial");
  });

  it("keeps memory and visible output bounded across partial lines and terminal escapes", () => {
    const tail = new Tail(40);
    tail.write("partial");
    tail.write(" line\n");
    expect(tail.getLines(1)).toStrictEqual(["partial line"]);
    for (let i = 0; i < 1000; i += 1) {
      tail.write(`\u001B[31mline ${i}\u001B[0m\n`);
    }

    expect(tail.getLines(10_000)).toHaveLength(40);
    expect(tail.getLines(1)).toStrictEqual(["line 999"]);
    tail.write("a".repeat(10_000));
    expect(tail.getLines(1)[0]).toHaveLength(4000);
  });
});
