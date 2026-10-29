# Expressions

[Getting started](../README.md)

Use `${…}` inside endpoint port strings and `env` values to resolve expressions:

| Expression                                | Result                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| `${port()}`                               | Allocate an available loopback port.                        |
| `${env('NAME')}`                          | Read an inherited or previously resolved environment value. |
| `${exec('command')}`                      | Run a shell command and use its trimmed standard output.    |
| `${docker.compose.port('service', 5432)}` | Read a running Docker Compose service's published TCP port. |

`run`, `hooks.bootstrap`, and `hooks.shutdown` go directly to the shell without expression
resolution. Use your shell's variable syntax in these commands, such as
`"run": "npm run dev -- --port $WEB_PORT"` on Unix. Bootstrap runs before endpoint ports and
configured environment values are available.

Startup runs in this order:

1. Set workspace variables and run `hooks.bootstrap` with the inherited environment.
2. Resolve endpoint ports in declaration order and determine their URLs.
3. Resolve `env` values in declaration order.
4. Publish proxy routes and run `run` with the resolved environment.

`env('NAME')` reads the current value from the inherited environment or an earlier resolution. If a
configured variable appears later, the reference reads its inherited value, if present. If neither
source supplies a value, resolution fails. Declare configured values before the expressions that
reference them to avoid an unintended inherited value.

Calling `port()` again allocates another port. Use `env('WEB_PORT')` to reuse an endpoint's port.
Endpoint expressions must resolve to integers from 1 to 65535. Ports are selected before servers
start. Applications must still handle binding failures.

Expressions use a small subset of JavaScript template-literal syntax: literal strings, numbers,
booleans and null, nested template literals, and direct calls to the helpers above. Helper calls and
their arguments resolve sequentially, exactly once; no `await` is needed. For example,
`${exec(env('SETUP_COMMAND'))}` resolves the command before running it.

Property access on results, method calls such as `${exec('command').trim()}`, operators, object and
array literals, functions, and spread arguments are rejected before any helper in the template runs.
`exec()` already trims its output. Put additional transformations in the shell command or in your
TypeScript configuration.

Command output is not evaluated again as an expression and is limited to 1 MiB. Configuration can
execute shell commands, so use configurations you trust.

For a literal `${port()}`, write `"\\${port()}"` in JSON. In interpolated strings, escape literal
backticks and account for JavaScript template-literal escaping after JSON parsing. Strings without
`${` pass through unchanged.
