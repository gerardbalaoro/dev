# Proxy setup

[Getting started](../README.md)

Install Portless or Caddy, then run `dev start`. The flow is **detect → setup → live**: `dev` finds the proxy, prepares it, and publishes your app's URLs.

For sessions with endpoints, `dev` tries Portless first, then Caddy, skipping providers that are unavailable or incompatible. Sessions without endpoints run without detecting or starting a proxy. Setup is shared across workspaces; there is no project-level proxy field.

Hostnames are claimed by a session in the shared per-user state directory before bootstrap runs. A second workspace requesting a claimed hostname fails instead of replacing the route. Stop the owning session before reusing its hostname, or choose a different project name. Claims survive crashes and are released by successful cleanup. Workspaces sharing a proxy must use the same `DEV_STATE_DIR`.

## Portless

Install [Portless](https://github.com/vercel-labs/portless#readme). `dev` starts its shared proxy automatically. HTTPS may require Portless’s one-time certificate trust setup. Your version must support `portless proxy start`, `portless get <name> --no-worktree`, and `portless alias <name> <port>`. Publication does not force termination of an existing Portless application.

The primary TLD must be `localhost`; LAN mode and a custom-only primary TLD are incompatible. Existing `PORTLESS_*` environment settings are honored. `dev` manages the session's aliases and application processes; the shared Portless proxy keeps running when a session stops.

## Caddy

Install [Caddy](https://caddyserver.com/docs/install) so `caddy` is on your `PATH`. No Caddyfile, JSON configuration, or separate start command is needed.

On `dev start`, `dev`:

1. Detects a running Caddy admin API or the installed binary.
2. Starts Caddy in the background if needed and creates its local HTTP server automatically.
3. Publishes routes and prints the app URLs.

The local listener uses port 8080 when available, otherwise another available port. Configured application ports are excluded from this allocation. An existing proxy listener or Caddy admin address that conflicts with an application port produces a startup error. URLs look like `http://myapp.localhost:8080`; use the URL printed by `dev`.

Generated configuration and logs live in `dev`’s machine state directory. Concurrent workspaces share setup, and stopping a session removes only its routes. Caddy stays running for other sessions.

If Caddy is already running, `dev` adds its server through [Caddy's admin API](https://caddyserver.com/docs/api), preserving existing servers and routes. A compatible existing server named `dev` is reused, including its HTTP or HTTPS listener. An incompatible server with that name produces a startup error instead of being overwritten.

The default admin address is `http://127.0.0.1:2019`. `CADDY_ADMIN` is an optional override for an existing installation. Automatic setup uses local HTTP and does not require certificate trust. Existing HTTPS setups retain their certificate and trust requirements.
