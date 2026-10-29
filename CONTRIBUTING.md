# Contributing

Use Node.js 24.11+ or 26+ and the pnpm version in `package.json`. Clone
[the repository](https://github.com/gerardbalaoro/dev), then run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Use `pnpm dev --help` to run the CLI from source. To try the build in another project, run
`node /absolute/path/to/dev/dist/cli.js` from that project's Git workspace.

## Tests

After a build, run the compiled CLI checks:

```sh
DEV_TEST_CLI=dist/cli.js pnpm test tests/cli.test.ts
```

Optional integration tests require external proxy binaries:

```sh
CADDY_TEST_BINARY=/absolute/path/to/caddy pnpm test tests/proxy/caddy-live.test.ts
PORTLESS_TEST_BINARY=/absolute/path/to/portless pnpm test tests/proxy/portless-live.test.ts
```

## Publishing a Release

1. Update `version` in `package.json`.
2. Run `pnpm check` and `pnpm test`.
3. Inspect package contents with `npm pack --dry-run`. The `prepack` hook builds the distribution.
4. Create an archive with `npm pack --pack-destination /tmp`.
5. In a temporary consumer project, install it with `npm install /tmp/gblab-dev-<version>.tgz`.
6. Check `npx dev --help`, `npx dev --version`, and an ESM import from `@gblab/dev`.
7. Authenticate to npm with an account that can publish to `@gblab`.
8. Run `npm publish`. The package publishes with public access.
9. Tag the published version and add [release notes](https://github.com/gerardbalaoro/dev/releases).
