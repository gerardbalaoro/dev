# Docker Compose

[Getting started](../README.md)

```json
{
  "dev": {
    "name": "myapp",
    "endpoints": {
      "web": { "port": "${port()}", "root": true },
      "api": "${port()}",
      "mail": "${docker.compose.port('mailpit', 8025)}"
    },
    "env": {
      "POSTGRES_PORT": "${docker.compose.port('postgres', 5432)}",
      "DATABASE_URL": "postgresql://localhost:${env('POSTGRES_PORT')}/app"
    },
    "hooks": {
      "bootstrap": "docker compose up -d",
      "shutdown": "docker compose down"
    },
    "run": "pnpm turbo run dev"
  }
}
```

Configure your apps to read `WEB_PORT` and `API_PORT`. Compose services must publish their container ports to the host. Use dynamically assigned host ports if you want to run multiple worktrees at once. The generated `COMPOSE_PROJECT_NAME` separates each workspace's Compose project.

Port lookups run after bootstrap and use the current workspace's Compose project. Missing or conflicting published ports fail with an error. Matching IPv4 and IPv6 mappings are treated as one port.
