# Programmatic API

[Getting started](../README.md)

The package provides an ESM API with TypeScript declarations. Use the default `dev` instance for the
working directory at import time, or `new Dev(cwd?)` for an independent configuration. Projects must
be Git worktrees, just as with the CLI.

```ts
import { dev, port, env, docker } from "@gblab/dev";

dev
  .hooks({
    bootstrap: "docker compose up -d",
    shutdown: "docker compose down",
  })
  .endpoints({ web: { port: port.free(), root: true } })
  .env({
    POSTGRES_PORT: docker.port("postgres", 5432),
    DATABASE_URL: `postgresql://localhost:${env.get("POSTGRES_PORT")}/app`,
  });

// Uses the configured run command and waits for its exit and cleanup.
const result = await dev.run();
process.exitCode = result.code;
```

The application must read its generated `WEB_PORT`. Docker services must publish the requested
container port to the host. The generated `COMPOSE_PROJECT_NAME` keeps each worktree's Compose
resources separate.

## Configuration

Configuration loads from the Git worktree root: the `dev` field in `package.json`, extended by
`dev.config.*`, then extended by the fluent settings. The final result is validated with
`ConfigSchema`. You can supply missing required settings programmatically, including when there is
no configuration file.

```ts
import { Dev } from "@gblab/dev";

const project = new Dev("/projects/my-app")
  .name("my-app")
  .extend({ run: "pnpm dev" })
  .env({ LOG_LEVEL: "debug" });
```

`name()`, `env()`, `endpoints()`, `hooks()`, and `extend()` return the same builder. They configure
future sessions without starting processes. Builder instances do not share configuration. Changes
after `start()` do not modify that session.

- `name` and `run` replace the detected values.
- `env`, `endpoints`, and `hooks` merge by key. A supplied endpoint replaces its complete
  definition; hook commands replace the corresponding phase rather than being appended.
- Repeated fluent calls apply in order. The last supplied value wins.
- Passing a command to `start()` or `run()` overrides only that invocation's main command.

Helpers return expression strings and do no I/O when called. Use them in endpoint ports and `env`
values in configuration files or fluent settings. You can embed these expressions in JavaScript
template strings:

| Helper                       | Resolution                                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `port.free()`                | Selects an available loopback port during setup.                   |
| `env.get(name)`              | Reads an inherited or previously resolved environment variable.    |
| `docker.port(service, port)` | Looks up the Compose service's published TCP port after bootstrap. |

Environment expressions resolve in declaration order. Reference a generated or earlier variable to
reuse its port; another `port.free()` expression selects another port. Selected ports are not held
open for the application, which must still handle binding failures.

## Explicit Ownership

`start(command?)` launches the configured application and returns a `Running` session while the
application continues in the background. Stop the session in a `finally` block:

```ts
const session = await project.start("pnpm dev:debug");

try {
  console.log(session.endpoints.web?.url);
  const result = await session.exec(["pnpm", "test"]);
  console.log(result.code, result.stdout, result.stderr);
} finally {
  await session.stop();
}
```

The handle exposes `workspace`, `endpoints`, and an environment snapshot in `env`. `exec(argv)` runs
from the worktree root with the session's resolved environment. It preserves argument boundaries,
captures stdout and stderr, and returns `{ code, stdout, stderr }`. A nonzero child exit resolves
with its code; launch failures and output exceeding the combined 1 MiB byte limit for stdout and
stderr reject.

`session.exited` is one `Promise<Result>` for the lifetime of the session. It resolves with
`{ code }` after the main application exits **and cleanup finishes**. Lifecycle or cleanup errors
reject it. `stop()` requests shutdown and returns that same promise; repeated calls are safe.
Natural application exit also starts cleanup, including cancellation of any in-flight
`session.exec()` commands. Further execution on a stopped session rejects.

## Managed Lifetime

`run()` owns cleanup. Without a callback it waits for application exit. With a callback it stops the
application when the callback returns or throws, waits for cleanup, and returns the callback's
value.

```ts
await project.run();
await project.run("pnpm dev:debug");

const tests = await project.run(async (session) => {
  return session.exec(["pnpm", "test"]);
});

await project.run("pnpm dev:debug", async (session) => {
  await session.exec(["pnpm", "test"]);
  await session.exited; // Keep the application running until it exits or is stopped.
});
```

A callback error is rethrown after cleanup. If both the callback and cleanup fail, an
`AggregateError` retains both errors. Nonzero command exits are returned as results, so callbacks
should check codes if later commands must not run after a failure.

## Lifecycle

Both entry points share the CLI's lifecycle:

1. Load and merge configuration, acquire the workspace lock, and recover stale state.
2. Reserve hostnames and run `hooks.bootstrap` with inherited environment and workspace variables.
3. Resolve endpoint ports, prepare the proxy, and resolve URLs and configured environment values.
4. Publish routes and launch the configured main command.
5. On shutdown, stop managed processes, remove routes and claims, run `hooks.shutdown`, and release
   the lock.

`start()` returns after process launch, not application readiness. A scoped callback runs alongside
the application. Commands that must precede launch belong in bootstrap, which runs before configured
environment values are resolved.

Starting an already-running workspace rejects; these entry points do not silently reuse sessions
with potentially different settings. Failed cleanup leaves recovery state for `dev stop` or the next
startup.

Programmatic sessions have a child owner process. The library installs no signal handlers in your
application and does not set its exit code. `dev stop` signals the owner without terminating your
application. If the embedding process exits, the owner attempts cleanup on disconnection. A forcibly
killed owner may require `dev stop` to recover, just as with a CLI session. Recovery tracks
concurrent `session.exec()` commands as well as the main application. If a command cannot be safely
stopped, its recovery state is retained and infrastructure teardown waits for a successful retry.

Programmatic startup, application, and hook output is quiet; `session.exec()` returns captured
output. The CLI retains its normal terminal UI.

## Inspection

Existing read-only exports remain available for sessions started through either interface:

```ts
import { Sessions, Workspaces } from "@gblab/dev";

const workspace = await Workspaces.git();
const values = await Sessions.env(workspace);
console.log(values.WEB_URL);
```

`Sessions.env` requires a running session.

| Export                         | Operations                                                               |
| ------------------------------ | ------------------------------------------------------------------------ |
| `Workspaces`                   | `git(cwd?)`, `name(project, git)`, `resolve(project, cwd?)`.             |
| `Sessions`                     | `get(workspace)`, `env(workspace)`, `alive(session)`, `directory(env?)`. |
| `loadConfig(root, extension?)` | Loads, extends, and validates configuration.                             |
| `ConfigSchema`                 | Validates configuration directly.                                        |

Public types include `Config`, `Extension`, `EndpointConfig`, `Workspace`, `Running`, `Result`, and
`ProcessResult`. The existing `Session` type describes persisted session state; `Running` describes
the live handle returned by `start()`.
