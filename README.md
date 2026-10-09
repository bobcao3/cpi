# cpi

Cheng Cao's coding agent, built on a versioned [Pi](https://pi.dev) fork. This
repository owns the CLI, extensions, skills, and supporting tools; Pi core is
maintained separately.

## Installed application

Install the npm release or the GitHub repository and run `cpi`. See
[installation and SDK usage](packages/cli/README.md). Package identity and
runtime requirements are defined in the
[CLI manifest](packages/cli/package.json).

cpi layers application wiring, extension tooling, skills, and supporting tools
on the pinned Pi packages; it does not patch Pi core in-tree. cpi is
MIT-licensed: redistribution must carry [`LICENSE`](LICENSE) and package
notices such as
[`packages/harness/NOTICE.md`](packages/harness/NOTICE.md).

## Development

See [AGENTS.md](AGENTS.md) for editable development, checks, and publication
verification. For one-time PATH and link setup, see
[editable installation](packages/cli/README.md#editable-development-install).

## References

- [Using cpi](docs/using-cpi.md) · [Background work](docs/background-work.md) ·
  [Session events](docs/session-events.md) · [Storage](docs/storage.md) ·
  [Activity browser](docs/activity-browser.md)
- [Configuration](packages/harness/cpi-config.default.json)
- [Skills](packages/harness/skills/)
- [Package boundary](docs/package-boundary.md)
