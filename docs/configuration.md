# Configuration

[Getting started](../README.md)

Use the `dev` field in the root `package.json`, or export a configuration from `dev.config.ts`,
`dev.config.js`, `dev.config.json`, or `dev.config.jsonc`. Configuration is always loaded from the
Git worktree root. A configuration file takes precedence over fields in that root package file,
using c12's merging rules. Parent package files and local/global rc files are not loaded. `.env`
files are not loaded automatically.

| Field             | Purpose                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Required project name: lowercase letters, digits, and single hyphens, starting with a letter and ending with a letter or digit; up to 54 characters. |
| `run`             | Required shell command to run in the foreground.                                                                                                     |
| `endpoints`       | Named HTTP services, each with a [port expression](expressions.md) or a `{ "port": "…", "root": true }` object.                                      |
| `env`             | Environment variables to resolve before running the main command.                                                                                    |
| `hooks.bootstrap` | Optional shell command to start supporting services, such as [Docker Compose](docker-compose.md), before resolving ports.                            |
| `hooks.shutdown`  | Optional shell command to clean up supporting services when the session ends.                                                                        |

Endpoint names follow the same naming rules, with a limit of 63 characters. At most one endpoint can
have `root: true`: it uses `<workspace>.localhost`. Other endpoints use
`<endpoint>.<workspace>.localhost`.

An endpoint named `web` generates `WEB_PORT` and `WEB_URL`; `my-api` generates `MY_API_PORT` and
`MY_API_URL`. Every managed process receives `WORKSPACE_NAME` and `COMPOSE_PROJECT_NAME`. Generated
variables cannot be overridden in `env`, and unknown configuration fields are rejected.

The main checkout uses the project name as its workspace name. Linked worktrees append an
eight-character hash of their absolute path. Moving a worktree changes its workspace name.
