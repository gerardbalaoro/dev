# Contributing

Clone [the repository](https://github.com/gerardbalaoro/dev) and install dependencies with the pnpm version in `package.json`. Running the CLI requires Node.js 24+; building requires Node.js 24.11+ or 26+.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Use `pnpm dev --help` to run the CLI from source. To try the build in another project, run `node /absolute/path/to/dev/dist/cli.js` from that project's Git workspace.

The build also generates agent skills from the shared command tree in `src/app.ts`. Crust's installer reads the generated `.crust/root/skills` directory, which ships in the npm package. Run `pnpm build` before trying `pnpm dev skills`. Command-specific agent guidance belongs in the command definition's metadata sections.

## Module exports

Use PascalCase for singleton objects and constants, including Zod schemas named `<Concept>Schema`. Prefer single-word names when the module supplies enough context. Keep standalone functions when they are useful independently; group related operations that callers use together into an object export.

The public fluent exports `dev`, `port`, `env`, and `docker` intentionally use lowercase names. `Dev` constructs independent instances.

Each file in `src/commands` owns its command metadata and action and has exactly one default Crust command definition export. The CLI entrypoint registers those definitions and configures shared extensions. Shared setup, helpers, and types belong outside that directory. Public package exports live in `src/index.ts`; update `docs/api.md` when their names or behavior change.

## Tests

Tests use temporary Git repositories and isolated proxy fixtures. Optional integration tests use external binaries:

```sh
CADDY_TEST_BINARY=/absolute/path/to/caddy pnpm test tests/proxy/caddy-live.test.ts
PORTLESS_TEST_BINARY=/absolute/path/to/portless pnpm test tests/proxy/portless-live.test.ts
```

After building, run `DEV_TEST_CLI=dist/cli.js pnpm test tests/cli.test.ts` to check the compiled CLI and packaged skill installation, repair, and removal. The skill installation check is skipped when testing from source.

## Publishing a release

1. Update `version` in `package.json`. The CLI reads its version from this field.
2. Run the checks:

   ```sh
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

3. Preview the package:

   ```sh
   npm pack --dry-run
   ```

   The `prepack` hook builds the distribution. Check that the package contains the compiled CLI, ESM API, TypeScript declarations, generated agent skills, README, MIT license, and package metadata. Source files, tests, and local session state are excluded.

4. Create and test the archive in a temporary consumer project:

   ```sh
   npm pack --pack-destination /tmp
   ```

   Install the resulting archive with `npm install /tmp/gblab-dev-<version>.tgz`, then check `npx dev --help`, `npx dev --version`, and an ESM import from `@gblab/dev`.

5. When ready to release, authenticate to npm with an account allowed to publish to the `@gblab` scope, then run:

   ```sh
   npm publish
   ```

   `publishConfig.access` is set to `public`. Publishing rebuilds the distribution through `prepack`.

6. Tag the published version and add release notes in [GitHub](https://github.com/gerardbalaoro/dev/releases).

See npm's [package scripts documentation](https://docs.npmjs.com/cli/using-npm/scripts) for lifecycle behavior and [scoped package documentation](https://docs.npmjs.com/cli/using-npm/scope) for publishing access.
