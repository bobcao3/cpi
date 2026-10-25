# Development and releases

Use this guide to build Ghostmux, check changes, or prepare release packages.
For terminal commands, start with the [README](README.md).

## Build and check changes

The [build manifest](build.zig.zon) records the Zig requirement and pins source
dependencies. Update a dependency with `zig fetch --save=<name> <url>` rather
than editing the pin by hand. Native changes need a rebuild. JavaScript changes
apply directly in a linked checkout.

From the package directory:

```sh
zig build --release=safe
zig build test --release=safe
```

From the repository root:

```sh
node --test packages/ghostmux/tests/integration.test.mjs
```

The rendering checks decode PNGs with `sharp`. The JavaScript daemon suites need
POSIX and Python. Set `GHOSTMUX_BIN` to check a relocated executable.
[build.zig](build.zig) defines native fixtures, including platform exclusions.
The [shared build workflow](../../.github/workflows/build-packages.yml) defines
the full verification matrix.

## Resolve a binary

JavaScript callers use `@bobcao3/cpi-ghostmux/resolve`. The `/source` and
`/signature` exports provide provenance and verification. The private workspace
alias is `@cpi/ghostmux`.

The [resolver](bin/ghostmux-resolve.mjs) defines selection order and
source-build opt-in. `GHOSTMUX_BIN` must name an absolute executable path.
Overrides and local builds bypass signature verification, so use only binaries
you trust. Packaged binaries must pass version, platform, signature, and
source-digest checks. Verification failure is an error, not permission to fall
back.

Check [platforms.json](platforms.json) for CPU requirements. Package managers
match OS and architecture without checking instruction support. For cpi
integration, see [monitor.ts](../harness/src/shell/monitor.ts) and
[the shell guidance](../harness/text/shell.toml).

## Prepare a release

The workspace package is private. Give
[scripts/package.mjs](scripts/package.mjs) a signed-artifact directory and a new
output directory. Publish in the order listed in its `packages.json`, with
native packages before the wrapper.

The [release workflow](../../.github/workflows/release-ghostmux.yml) controls
publication. Disabling npm publication does not make it a dry run. The workflow
still publishes a GitHub release.

[Install checks](tests/install.test.mjs) use isolated npm and Bun installs.
`GHOSTMUX_TEST_ARTIFACT` selects signed artifacts for package verification.
Before redistribution, read [the supplemental notices](licenses/NOTICE.md) and
check the files in the actual bundle.
