import { watch } from "@/process/signals";
import { launch } from "@/session/launch";
import type { Running } from "@/session/launch";
import { failure } from "@/session/protocol";
import type { Request, Response } from "@/session/protocol";
import type { UI } from "@/ui/index";

function ignore(): void {
  // Programmatic sessions do not render terminal UI.
}

const Silent: UI = {
  error: ignore,
  info: ignore,
  output: () => ({ finish: ignore, write: ignore }),
  showEndpoints: ignore,
  start: ignore,
};

const signals = watch();
const controller = new AbortController();
let session: Running | undefined;
let isStarted = false;

function send(message: Response): void {
  if (process.connected) {
    process.send?.(message, ignore);
  }
}

async function receive(message: Request): Promise<void> {
  if (message.type === "stop") {
    controller.abort();

    return;
  }

  if (message.type === "exec") {
    try {
      if (!session) {
        throw new Error("The session is not running");
      }

      send({
        id: message.id,
        result: await session.exec(message.command),
        type: "result",
      });
    } catch (error) {
      send({
        error: failure(error instanceof Error ? error : new Error(String(error))),
        id: message.id,
        type: "failure",
      });
    }

    return;
  }

  if (isStarted) {
    return;
  }

  isStarted = true;

  try {
    session = await launch(
      message.cwd,
      message.config,
      Silent,
      AbortSignal.any([signals.signal, controller.signal])
    );
    send({
      session: {
        endpoints: session.endpoints,
        env: session.env,
        workspace: session.workspace,
      },
      type: "ready",
    });
    const result = await session.exited;
    send({
      result: { code: signals.getExitCode() || result.code },
      type: "exit",
    });
  } catch (error) {
    send({
      error: failure(error instanceof Error ? error : new Error(String(error))),
      type: "error",
    });
  } finally {
    signals.dispose();

    if (process.connected) {
      process.disconnect?.();
    }
  }
}

process.on("message", (message: Request) => {
  void receive(message);
});

process.once("disconnect", () => {
  controller.abort();

  if (!isStarted) {
    signals.dispose();
  }
});
