import { fork } from "node:child_process";

import type { Extension } from "@/config/types";
import type { ProcessResult } from "@/process/run";
import type { Result, Running } from "@/session/launch";
import { restore } from "@/session/protocol";
import type { Request, Response } from "@/session/protocol";

export function connect(cwd: string, config: Extension): Promise<Running> {
  const isSource = import.meta.url.endsWith(".ts");
  const worker = new URL(
    isSource ? "../worker.ts" : "./worker.js",
    import.meta.url
  );
  const child = fork(worker, [], {
    // The owner has its own entrypoint; caller eval/debug flags must not leak into it.
    execArgv: isSource ? ["--import", import.meta.resolve("tsx")] : [],
    stdio: ["inherit", "ignore", "pipe", "ipc"],
  });
  const ready = Promise.withResolvers<Running>();
  const completion = Promise.withResolvers<Result>();
  const pending = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<ProcessResult>>
  >();
  let sequence = 0;
  let isFinished = false;
  let isStopping = false;
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8000);
  });
  // Completion may precede the caller attaching a handler (including failed startup).
  void completion.promise.catch(() => {
    // The original promise remains rejected for the caller to observe.
  });

  function fail(error: Error): void {
    isFinished = true;
    ready.reject(error);
    completion.reject(error);
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }
  function send(message: Request): void {
    if (!child.connected) {
      fail(new Error("Session owner disconnected"));
      return;
    }
    child.send(message, (error) => {
      if (error && !isFinished) {
        fail(error);
        child.kill("SIGTERM");
      }
    });
  }
  child.on("message", (message: Response) => {
    switch (message.type) {
      case "ready": {
        ready.resolve({
          ...message.session,
          exec(command) {
            if (isFinished || isStopping) {
              return Promise.reject(new Error("The session has stopped"));
            }
            const request = Promise.withResolvers<ProcessResult>();
            const id = sequence;
            sequence += 1;
            pending.set(id, request);
            send({ command, id, type: "exec" });
            return request.promise;
          },
          exited: completion.promise,
          stop() {
            if (!isFinished && !isStopping) {
              isStopping = true;
              send({ type: "stop" });
            }
            return completion.promise;
          },
        });
        break;
      }
      case "exit": {
        isFinished = true;
        completion.resolve(message.result);
        break;
      }
      case "error": {
        fail(restore(message.error));
        break;
      }
      case "result": {
        pending.get(message.id)?.resolve(message.result);
        pending.delete(message.id);
        break;
      }
      case "failure": {
        pending.get(message.id)?.reject(restore(message.error));
        pending.delete(message.id);
        break;
      }
      default: {
        fail(new Error("Invalid session response"));
      }
    }
  });
  child.once("error", fail);
  child.once("close", (code, signal) => {
    if (!isFinished) {
      fail(
        new Error(
          `Session owner exited unexpectedly (${signal ?? code}): ${diagnostic.trim()}`
        )
      );
    }
    for (const request of pending.values()) {
      request.reject(new Error("The session has stopped"));
    }
    pending.clear();
  });
  send({ config, cwd, type: "start" });
  return ready.promise;
}
