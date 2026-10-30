import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Identity } from "@/process/identity";

describe.skipIf(process.platform !== "linux")("Linux process identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it.each(["ENOENT", "ESRCH"])(
    "treats a process disappearing during inspection as exited (%s)",
    async (code) => {
      const read = vi
        .spyOn(fs, "readFile")
        .mockRejectedValueOnce(Object.assign(new Error("Process disappeared"), { code }));

      syncBuiltinESMExports();
      await expect(Identity.get(process.pid)).resolves.toStrictEqual({
        pid: process.pid,
      });
      expect(read).toHaveBeenCalledWith(`/proc/${process.pid}/stat`, "utf-8");
    }
  );

  it("preserves inspection errors that do not indicate an exited process", async () => {
    const error = Object.assign(new Error("Permission denied"), {
      code: "EACCES",
    });

    vi.spyOn(fs, "readFile").mockRejectedValueOnce(error);
    syncBuiltinESMExports();
    await expect(Identity.get(process.pid)).rejects.toBe(error);
  });
});
