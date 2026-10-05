# Release preparation

These commands prepare Node package artifacts without publishing. Do not use the
upstream Pi publishing workflow to distribute cpi.

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
node packages/cli/scripts/check-boundaries.mjs
node packages/cli/scripts/package.mjs /tmp/cpi-release-a
node packages/cli/scripts/verify-installed.mjs /tmp/cpi-release-a --tui
node packages/cli/scripts/package.mjs /tmp/cpi-release-b
cmp /tmp/cpi-release-a/SHA256SUMS /tmp/cpi-release-b/SHA256SUMS
```

Keep source, lockfile, platform, and toolchain unchanged between builds. The
builder consumes the fork artifact set recorded in `vendor/pi/manifest.json`,
locked dependency archives, and verified supporting-tool artifacts. Pi-specific
build inputs, including the model catalog, belong to fork artifact preparation;
this builder must not hydrate them from a Pi source checkout. The
builder requires signed Ghostmux and WASM inputs; use the tool resolvers'
explicit artifact overrides to select them. The installed-consumer verifier
requires tmux and JJ for terminal checks and uses
local model fixtures rather than paid providers.

Review `release-manifest.json`, `runtime-lock.json`, and `SHA256SUMS` alongside
the tarball. The manifest identifies the source revision, compiler, model
catalog, native binary, package versions, and license inventory. Distribute the
tarball and these records together. Keep the staging directory private.

The tarball targets the builder's platform. Verify every supported target on
that target before distribution. Install Bun on the verification host to
exercise the Bun global-install verification; the verifier reports a skip when Bun
is unavailable. Both installers are tested with the registry inaccessible;
provider requests and other shell-tool provisioning can still require network
access. Ghostmux and Tree-sitter are included in the archive. Consumers install the tarball as
described in `README.md` and replace the tarball for upgrades.

The builder uses npm's pack file list, then archives the complete application
with no install-time dependencies. The dependency inventory remains in
`release.json` and `runtime-lock.json`. This avoids Bun resolving bundled,
unpublished fork versions from the registry when installing a local tarball.

Before publishing, obtain authorization for the destination and release version.
Public upstream package versions do not identify the fork's source; the bundled
fork and release provenance do. This procedure does not publish npm packages,
push revisions, or build standalone Bun executables.
