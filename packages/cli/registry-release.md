# Registry release

[Registry CI](../../.github/workflows/registry.yml) publishes version tags.

The Pi fork can rebase independently. cpi pins immutable backend archives so
a moving fork checkout cannot silently change an installed release.
CI tests assembled npm/Bun installations because workspace dependencies can
hide missing files and broken dependency declarations during source checks.

## Release

1. Check the [Pi pin](../../vendor/pi/manifest.json). If new Pi APIs are needed,
   push a release tag in [the fork](https://github.com/bobcao3/pi).
   CI publishes durable archives and opens the pin PR. Review the pin and locks;
   require passing PR checks and merge before tagging cpi. Otherwise skip Pi.
2. Push the reviewed cpi tag `vX.Y.Z` to GitHub.
   Review CI archives, checksums, provenance, and platform reports before
   approving publication. CI verifies public npm and Bun installations.

## Recover

A failed run may have published some packages. Retrying identical bytes keeps
the version and artifact identities consistent across registries and mirrors.

- Rerun failed jobs on the original tag. For a manual publishing retry, select
  that tag in registry CI and enable its publishing input.
- If fork notification fails, rerun it or dispatch
  [pin CI](../../.github/workflows/sync-pi-release.yml) with the explicit
  published fork tag. Maintainers still review and merge the PR.
- Never move pushed tags, overwrite assets, or reuse versions for changed bytes.
  Resolve content conflicts in a new release; retain verified archives/reports.
