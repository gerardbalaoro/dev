export function watch() {
  const controller = new AbortController();
  let code = 0;

  const interrupt = () => {
    code ||= 130;
    controller.abort();
  };

  const terminate = () => {
    code ||= 143;
    controller.abort();
  };

  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  return {
    dispose() {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    },
    getExitCode: () => code,
    signal: controller.signal,
  };
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
