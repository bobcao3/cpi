# cpi

Cheng Cao's coding agent, built on a versioned [Pi](https://pi.dev) fork. This
repository owns the CLI, extensions, skills, and supporting tools; Pi core is
maintained separately.

## Installed application

Install the packaged release and run `cpi`. See
[installation and SDK usage](packages/cli/README.md). Package identity and
runtime requirements are defined in the
[CLI manifest](packages/cli/package.json).

## Development and artifacts

Read [AGENTS.md](AGENTS.md). Run `bun run install:dev` to install the pinned
dependencies and link `cpi` to this checkout, then run `bun run check`.
See [editable installation](packages/cli/README.md#editable-development-install)
for PATH setup and source reloads. `npm ci --ignore-scripts` remains supported.
Checks resolve the
installed fork packages, not a neighboring source checkout. Formatting is
limited to maintained application and tool source; historical documents and
benchmarks are not formatter inputs.

The fork artifact set is recorded in `vendor/pi/manifest.json`. Update that set
and its dependency pins together; do not substitute upstream packages or local
source links. See [release packaging](packages/cli/RELEASE.md) for artifact
production and independent installed-package verification. Publishing is a
separate authorized operation.

## References

- [Usage](docs/usage.md)
- [Configuration](packages/extensions/cpi-config.default.json)
- [Skills](packages/extensions/skills/)
- [Package boundary](docs/CPI_PROTOTYPE.md)
