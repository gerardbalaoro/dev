# @gblab/dev

Run your app in multiple Git worktrees, each with its own ports, local URLs, and environment
variables.

## Install

Requires Node.js 24+ and Git. Sessions with HTTP endpoints also require
[Portless or Caddy](docs/proxies.md).

```sh
npm install --global @gblab/dev
```

## Usage

For an app that reads `PORT`, add this to your project's root `package.json`:

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

```sh
dev start
```

Open the printed URL: `myapp.localhost` for the main checkout or `myapp-<hash>.localhost` for linked
worktrees.

## Commands

| Command                 | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `dev start`             | Start the app.                                             |
| `dev status`            | Show session status and URLs.                              |
| `dev exec <command...>` | Run a command with the session's saved environment values. |
| `dev stop`              | Stop the session and clean up.                             |

## Documentation

- [Configuration](docs/configuration.md)
- [Docker Compose](docs/docker-compose.md)
- [Sessions and Recovery](docs/sessions.md)
- [TypeScript API](docs/api.md)

[Contributing](CONTRIBUTING.md) · [MIT License](LICENSE)
