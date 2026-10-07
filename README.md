# cpi

Cheng Cao's coding agent, built on a versioned [Pi](https://pi.dev) fork. This
repository owns the CLI, extensions, skills, and supporting tools; Pi core is
maintained separately.

## Installed application

Install the npm release or the GitHub repository and run `cpi`. See
[installation and SDK usage](packages/cli/README.md). Package identity and
runtime requirements are defined in the
[CLI manifest](packages/cli/package.json).

## Development and artifacts

Read [AGENTS.md](AGENTS.md). Run `bun run install:dev` to install the pinned
dependencies and link `cpi` to this checkout, then run `bun run check`. See
[editable installation](packages/cli/README.md#editable-development-install) for
PATH setup and source reloads. `npm ci --ignore-scripts` remains supported.
Checks resolve the installed fork packages, not a neighboring source checkout.
Formatting is limited to maintained application and tool source; historical
documents and benchmarks are not formatter inputs.

### Editing the fork

`CPI_FORK` points the CLI at a Pi fork checkout: `@earendil-works/*` resolves
through the fork's TypeScript sources, so core edits run with no build or
artifact install.

```sh
node scripts/dev.mjs            # this checkout against a sibling cpi-fork
CPI_FORK=/path/to/fork cpi      # any cpi; export to persist
```

[scripts/dev.mjs](scripts/dev.mjs) also runs under `bun` and defaults `CPI_FORK`
to the sibling `cpi-fork`. Unset `CPI_FORK` to use the pinned artifacts.

The fork artifact set is recorded in `vendor/pi/manifest.json`. Update that set
and its dependency pins using
[the artifact importer](packages/cli/scripts/import-pi.mjs). Use durable release
assets, not expiring CI downloads; do not add package archives to this
repository or substitute upstream packages or local source links. See
[release packaging](packages/cli/RELEASE.md) for artifact production and
independent installed-package verification. Publishing is a separate authorized
operation.

## References

- [Usage](docs/usage.md)
- [Configuration](packages/extensions/cpi-config.default.json)
- [Skills](packages/extensions/skills/)
- [Package boundary](docs/CPI_PROTOTYPE.md)
