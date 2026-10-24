# @gblab/dev

Run your app in multiple Git worktrees, each with its own ports, local URLs, and environment variables.

## Install

Requires Node.js 24+ and Git. Sessions with HTTP endpoints also require [Portless or Caddy](https://github.com/gerardbalaoro/dev/blob/main/docs/proxies.md); `dev start` detects the installed proxy and sets it up automatically. Workers without endpoints can run without a proxy.

```sh
npm install --global @gblab/dev
```

## Usage

Add a `dev` field to your project's root `package.json`:

```json
{
  "dev": {
    "name": "myapp",
    "endpoints": {
      "web": { "port": "${port()}", "root": true }
    },
    "env": {
      "PORT": "${env('WEB_PORT')}"
    },
    "run": "npm run dev"
  }
}
```

This example runs your existing `dev` script with an available port in `PORT`. Adjust `run` and the variable name to suit your app. If your framework restricts hostnames, allow the generated `.localhost` hostname.

```sh
dev start
```

Open the URL printed in the terminal. The main checkout gets `myapp.localhost`; linked worktrees get names such as `myapp-a1b2c3d4.localhost`. The proxy determines the scheme and port.

Press Ctrl+C to [stop the session](https://github.com/gerardbalaoro/dev/blob/main/docs/sessions.md#cleanup-and-recovery). `dev` stops the app, removes its proxy routes, and runs your shutdown hook if configured.

## Commands

Run these from inside your project's Git workspace:

| Command | What it does |
| --- | --- |
| `dev start` | Start the app in the foreground. |
| `dev status` | Show session status and URLs. |
| `dev exec <command...>` | Run a command with the [active session's environment](https://github.com/gerardbalaoro/dev/blob/main/docs/sessions.md#commands). |
| `dev stop` | Stop the session and clean up. |

For example, run `dev exec npm run db:migrate` in another terminal to use the running app's environment.

## Agent skills

The CLI ships an agent skill generated from its command definitions. Install it into the current project's agent directories with:

```sh
dev skills install --all --scope project
```

Run `dev skills` for interactive installation, `dev skills repair` to repair links after moving an installation, or `dev skills uninstall --all --scope project` to remove the project's links. These commands do not require a running development session.

## Configuration

[Configuration](https://github.com/gerardbalaoro/dev/blob/main/docs/configuration.md) lives in the root `package.json` or a `dev.config.ts`, `.js`, `.json`, or `.jsonc` file. `.env` files are not loaded automatically.

Each endpoint generates `<NAME>_PORT` and `<NAME>_URL`. Use `root: true` for `myapp.localhost`, or omit it for `web.myapp.localhost`.

| [Expression](https://github.com/gerardbalaoro/dev/blob/main/docs/expressions.md) | Value |
| --- | --- |
| `${port()}` | An available local port. |
| `${env('NAME')}` | An inherited or previously resolved environment variable. |
| `${exec('command')}` | The command's trimmed stdout. |
| `${docker.compose.port('service', 5432)}` | A Compose service's published TCP port. |

Use `hooks.bootstrap` to start services before resolving the environment and `hooks.shutdown` to stop them. For [Docker Compose](https://github.com/gerardbalaoro/dev/blob/main/docs/docker-compose.md), each worktree gets its own `COMPOSE_PROJECT_NAME`.

## API

Use the [TypeScript API](https://github.com/gerardbalaoro/dev/blob/main/docs/api.md) to configure and run sessions from scripts:

```ts
import { dev } from "@gblab/dev";

await dev.run(async (session) => {
  const result = await session.exec(["pnpm", "test"]);
  process.exitCode = result.code;
}); // Stops the application and runs shutdown before returning.
```

Use `await dev.run()` to wait for the configured application to exit, or `await dev.start()` for a session you stop explicitly with `session.stop()`.

[Contributing](https://github.com/gerardbalaoro/dev/blob/main/CONTRIBUTING.md) · [MIT License](https://github.com/gerardbalaoro/dev/blob/main/LICENSE)
