# Registry release

In short: the release workflow installs and verifies the package set, then
publishes with npm trusted publishing over GitHub Actions OIDC — no npm secret.
Review the archives, `packages.json`, `SHA256SUMS`, and `fork-provenance.json`
before approving; the publisher releases the CLI only after its dependencies
and re-checks installations against the registry.

Use [Registry installation](../../.github/workflows/registry.yml) to prepare,
verify, and publish the package set. Its platform matrix installs the CLI by
registry name with npm and Bun, with lifecycle scripts disabled, and exercises
the SDK, extensions, Ghostmux, Tree-sitter WASM, and codemode worker.

Configure each public package's npm trusted publisher to match the publishing
job's GitHub repository, workflow filename, and environment. Allow direct
publishing. The job authenticates through GitHub Actions OIDC; no npm publishing
secret is used. Initial trust configuration requires the owner's interactive
npm two-factor authentication. For new packages, npm's staged publishing can
create the package before configuring trust.

If release archives were staged to create package records, reject those temporary
stages after configuring trust and before running the direct publisher: npm
reserves staged version numbers. Keep the verified archives and reports; rejecting
a stage removes its registry copy, not the local or CI artifacts. Subsequent
releases of an established package do not need this bootstrap step.

Run the workflow manually with its publishing input enabled. Review the
package archives, `packages.json`, `SHA256SUMS`, and `fork-provenance.json` from
the packaging job before approving publication. The publisher requires matching
verification reports and publishes the CLI only after its dependencies.
After publishing, the job repeats installation checks against the public registry.
Package repository metadata identifies the distribution builder for provenance;
the generated Pi manifests also retain their pinned fork source and integrity.

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

Before importing a fork artifact set for repository-source installations, run
[pin-pi-artifact-dependencies.mjs](scripts/pin-pi-artifact-dependencies.mjs)
against the verified archives and the durable release URL. Upload the resulting
hash-named archives without replacing existing release assets, then run the
[artifact importer](scripts/import-pi.mjs) and refresh the reviewed locks.
