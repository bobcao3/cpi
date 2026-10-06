# Registry release

Use [Registry installation](../../.github/workflows/registry.yml) to prepare,
verify, and publish the package set. Its platform matrix installs the CLI by
registry name with npm and Bun, with lifecycle scripts disabled, and exercises
the SDK, extensions, Ghostmux, Tree-sitter WASM, and codemode worker.

Run the workflow manually with its publishing input enabled after configuring
the `NPM_TOKEN` Actions secret and the `npm-publish` environment. Review the
package archives, `packages.json`, `SHA256SUMS`, and `fork-provenance.json` from
the packaging job before approving publication. The publisher requires matching
verification reports and publishes the CLI only after its dependencies.

The distribution builder consumes the pinned Pi artifact manifest and verified,
signed native artifacts. Registry aliases retain original Pi import names while
selecting our public fork packages; no upstream source edits are needed to rename
them. Public names are defined in
[registry-manifest.mjs](scripts/registry-manifest.mjs). First-party package
manifests contain no lifecycle scripts. Third-party hooks are not required.

For local preparation and verification, use new output directories:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
node scripts/ci-native-artifacts.mjs /tmp/cpi-native --all
node packages/cli/scripts/package-registry.mjs /tmp/cpi-native /tmp/cpi-registry
node packages/cli/scripts/verify-registry.mjs /tmp/cpi-registry
```

Never republish different bytes under an existing version. The publisher verifies
existing archive integrity before resuming a partially completed release. Pi
source updates must first pass the separate fork's artifact workflow; this
builder never imports from a neighboring checkout.
