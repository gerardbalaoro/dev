# Worklog

## Generated agent skills

Register Crust's skills extension on a shared application definition so users can install, repair,
and uninstall generated skills. Generate the skill files after a successful tsdown build and include
`.crust/root/skills` in the npm package, matching the artifact directory Crust resolves for this
build layout. Keep generated files out of Git.

Describe exec's raw argument forwarding in its own metadata so agents know that child help and
version flags are forwarded and that a running session is required. Document skill installation and
the build workflow, and include the skills command in CLI help checks.

Validation: all 17 compiled CLI checks pass, including project installation, dangling-link repair,
and removal; the live-session forwarding regression also passes. An npm archive installed in an
isolated consumer includes the generated skills and supports skill management and the public API
import. Source CLI checks, type checking, linting, formatting, the build, and diff whitespace checks
pass.

## CrustJS CLI

Replace CAC with `@crustjs/core` and `@crustjs/extensions`. Each command file owns and exports its
Crust command definition, including metadata and action; the CLI entrypoint registers those
definitions and configures shared extensions. Generate help and version output with extensions, and
let Crust report command errors on stderr. Keep command exit codes and normalize `exec` arguments
into Crust's raw argument channel so child flags, empty arguments, and optional separators pass
through unchanged.

Require Node.js 24+ to match Crust's supported runtimes, target Node.js 24 in the build, and update
installation and contributor instructions.

Add subprocess checks for help outside a workspace, version flags, invalid commands and flags,
missing exec arguments, and child help/version forwarding. Extend the live-session regression to
verify exact environment reuse, argument boundaries, and child exit codes with and without an
explicit separator. The version regression caught help intercepting the version flag; registering
the version extension first fixes it.

Validation: the full suite and targeted reruns cover 178 passing tests; six optional live-proxy
tests are skipped. All 15 CLI checks and the live-session forwarding test also pass against the
compiled CLI. Type checking, linting, formatting, the build, and diff whitespace checks pass.

## Lifecycle gap fixes

Persist concurrent `session.exec()` process identities and serialize journal updates so starts and
exits cannot overwrite each other's recovery records. After an owner crash, recover each command
before infrastructure teardown. Retain unfinished command records and defer shutdown hooks when
process ownership cannot be verified. Older session records without the command list remain
readable.

Enforce the combined stdout/stderr capture limit using incoming byte counts, including multibyte
text, and stop retaining output after overflow. Share environment-name, Compose-service, and port
validation between fluent helpers and expression resolution.

Add regressions for unexpected owner death with concurrent commands, failed recovery followed by a
retry, worker-side execution errors, and command termination before shutdown hooks on both explicit
stop and natural application exit. Cover multibyte output over the capture limit, combined
stdout/stderr overflow, and output exactly at the limit. The crash-recovery and multibyte
regressions failed against the original implementation before the fixes.

Validation: 163 tests pass; six optional live-proxy tests are skipped. All 18 programmatic
integration tests also pass against the compiled package, including CLI invocations without a
TypeScript loader. Type checking, linting, formatting, the build, and diff whitespace checks pass.
Native macOS and Windows execution remains unverified.

## Programmatic lifecycle

Add the default `dev` instance, independent `Dev(cwd?)` builders, and deferred `port`, `env`, and
`docker` helper objects. Merge fluent extensions over discovered configuration before validation,
replacing supplied endpoint definitions and merging environment variables and hooks by key.

`start(command?)` returns a live session with `exec()`, idempotent `stop()`, and a stable `exited`
promise that settles after cleanup. `run()` manages the lifetime, either waiting for application
exit or scoping it to an optional callback and returning the callback's value after cleanup.
Preserve callback and cleanup failures together.

Extract shared startup orchestration from the CLI. Programmatic sessions use a separate owner
process so external `dev stop` cannot terminate an embedding application. On normal shutdown, cancel
in-flight commands before removing routes and running the shutdown hook; on parent disconnection,
attempt cleanup. Preserve caller entrypoint isolation when launching the owner, including inline ESM
callers.

Add real-process integration tests for lifecycle ownership, configuration extensions, command
overrides, exact environment reuse, startup rollback, shutdown failures, parent exit, and inline ESM
execution. Exercise the same tests against the compiled package without a TypeScript loader. Update
API documentation and the README.

Validation: 154 tests pass; six optional live-proxy tests are skipped. All 12 programmatic
integration tests also pass against the JavaScript distribution. Type checking, linting, formatting,
and the build pass. The inline ESM regression was reproduced before its launch-argument fix.

## Test signal audit

Apply
[useless-test-pruner](https://github.com/drmrduck/skills/blob/main/useless-test-pruner/SKILL.md). No
tests were proven wholly useless; keep the platform-specific and optional live-proxy tests.
Strengthen three existing tests without removing assertions:

| Test                         | Mutation missed before, caught afterward                                  |
| ---------------------------- | ------------------------------------------------------------------------- |
| Endpoint resolution          | Return an empty endpoint map after setting environment variables.         |
| Proxy selection              | Return the selected provider before its asynchronous setup finishes.      |
| Docker service interpolation | Pass a hard-coded `postgres` service instead of the requested `mail-pit`. |

Each original test passed its mutation probe; each strengthened test failed the same probe. Restore
the original production source after every probe. Zero tests deleted; three strengthened.

Validation: 141 tests pass and six optional live-proxy tests are skipped. Lint, formatting, type
checking, and the build pass. No coverage was removed; code-coverage percentages were not measured.

## Module exports

Use PascalCase for schemas, constants, and singleton objects. Group related operations under
`Workspaces`, `Sessions`, `Identity`, and `Endpoints`, and shorten module-local export names. Each
command has one default function export; shared command setup lives in `src/context.ts`. Update
imports, tests, and the public API documentation for the new names.

Validation: 141 tests pass; six optional live-proxy tests are skipped. Type checking, linting,
formatting, the build, and built CLI/API smoke checks pass.

## Initial implementation and review

Implement the `@gblab/dev` CLI and API for worktree-specific development ports, URLs, environment
expressions, and recoverable sessions with Caddy and Portless.

Review the implementation against the repository documentation and address route ownership, process
identity and descendant recovery, proxy port conflicts, workspace configuration boundaries,
non-interactive output, and expression evaluation. Centralize session persistence and support
workers without endpoints.

Validation: all 142 tests pass, including live Caddy and Portless integration tests. Type checking,
linting, the build, and CLI/API smoke checks pass. Native macOS and Windows execution remains
unverified.
