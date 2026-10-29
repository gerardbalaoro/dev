# Sessions

[Getting started](../README.md)

## Commands

`dev exec` requires a running session. It inherits the invoking shell's environment, then overrides
matching variables with the session's saved generated and configured values. Other inherited
variables can differ from those present at startup. It reuses the session's ports without starting
services or allocating new ports.

Arguments after `exec`, including `--help`, are passed to the child command. For shell syntax,
invoke a shell explicitly:

```sh
dev exec sh -c 'echo "$WEB_URL" && npm run db:migrate'
```

Commands and hooks run from the Git workspace root; `dev exec` runs from your current directory.
`status`, `stop`, and `exec` remain usable if the startup configuration is changed or removed. Main
commands and `exec` preserve child exit codes; interrupted starts return 130 for SIGINT or 143 for
SIGTERM.

## Cleanup and Recovery

When the main command exits, you press Ctrl+C, or you run `dev stop`, the session stops its process
tree, removes its proxy routes, and runs the shutdown hook. Shutdown is also attempted after a
failed startup. Hooks should tolerate retries.

If cleanup fails, session state is retained so the next `dev stop` or `dev start` can retry
unfinished work. A restart waits for cleanup to succeed. After a crash or forced termination, run
`dev stop` to clean up; recovery may take several seconds while a stale lock expires.

Recovery verifies process creation identity before sending signals. On Unix, managed descendants
also inherit a recovery token so cleanup can recognize a surviving process group after its leader
exits. If ownership cannot be verified, cleanup reports an error and retains its state. Completed
route removals and shutdown hooks are recorded separately from the session's resolved endpoints.

When output is redirected or captured by another tool, application logs stream directly instead of
using the terminal's live display.

Session state is stored outside the repository in the per-user state directory. On Linux this is
`$XDG_STATE_HOME/dev` or `~/.local/state/dev`; macOS and Windows use the platform's application data
directory. Set `DEV_STATE_DIR` to override it. State includes generated and configured environment
values, which may contain secrets. Directories and files use owner-only permissions where supported.

Shutdown hooks have a 30-second limit. Managed process trees receive a two-second grace period
before forceful termination; deliberately detached processes are outside supervision. macOS, Linux,
and WSL are the primary targets. Native Windows uses its default shell and `taskkill`; shell syntax
and filesystem permissions vary by platform.
