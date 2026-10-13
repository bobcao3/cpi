# Registry release

Maintainers release cpi by pushing a version tag after configuring the publishing
credentials and environment. CI verifies the tagged source and installed packages
before publishing. No local npm publication is necessary.

[Release](#release) · [Configure once](#configure-once) · [Recover](#recover)

## Release

1. If cpi needs new Pi APIs, first push a release tag such as `cpi-1.1.1-1` in
   [the Pi fork](https://github.com/bobcao3/pi). The fork's
   [artifact workflow](https://github.com/bobcao3/pi/blob/cpi-fork/.github/workflows/fork-artifacts.yml)
   builds and verifies durable archives, then notifies cpi.
2. Wait for [Sync Pi release pin](../../.github/workflows/sync-pi-release.yml)
   to open the pin-update PR. Review the manifest and lock changes, require passing
   PR checks, and merge before tagging cpi. Skip these steps when the current
   [Pi pin](../../vendor/pi/manifest.json) already supplies the required APIs.
3. Push a cpi version tag such as `v0.0.4` to GitHub. The
   [registry workflow](../../.github/workflows/registry.yml) derives distribution
   versions from the tag without rewriting source manifests. Branch and PR runs
   verify packages without publishing.
4. If the publishing environment requires approval, review the package archives,
   `packages.json`, `SHA256SUMS`, `fork-provenance.json`, and platform reports
   before approving. CI publishes dependencies before the CLI, verifies public
   npm and Bun installations, then creates the GitHub release.

The builder uses the committed Pi pin and signed native releases, never the
latest Pi release or a neighboring checkout. A new Pi release has no effect on
cpi until a maintainer merges the pin-update PR.

## Configure once

- Configure each public package's npm trusted publisher for the GitHub repository,
  `registry.yml`, and the `npm-publish` environment. Allow direct publishing.
  GitHub Actions authenticates through OpenID Connect (OIDC); no npm publishing
  secret is needed.
- Allow `v*` tags in the environment's deployment policy. Retain required reviewers
  when publication should require human approval. Tag-triggered automation does
  not bypass environment protection.
- Register a private App in [GitHub's App settings](https://github.com/settings/apps/new).
  Follow [GitHub's registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
  Use the cpi repository URL as the homepage, disable webhooks, and leave OAuth
  callback URLs empty; the pin workflows use installation authentication.
  Grant the repository permissions requested by the
  [pin workflow](../../.github/workflows/sync-pi-release.yml), install the App only
  on `bobcao3/cpi`, and generate its private key in the App settings.
  Sign in with `gh auth login` using a repository administrator account, then set
  the App configuration in both repositories with the standard GitHub CLI:

  ```sh
  for repo in bobcao3/cpi bobcao3/pi; do
    gh variable set CPI_PIN_APP_CLIENT_ID --repo "$repo" --body '<Client ID>'
    gh secret set CPI_PIN_APP_PRIVATE_KEY --repo "$repo" < /path/to/private-key.pem
  done
  ```

  The workflows mint short-lived GitHub App tokens for GitHub API writes.
  npm publication uses OIDC; neither operation requires a personal token.

For a new npm package, the owner may need interactive two-factor authentication
to establish trusted publishing. If npm staging created package records, reject
the temporary stages before direct publication because npm reserves staged
versions. Keep the verified archives and reports.

## Recover

Rerun failed jobs in the original tagged workflow. If fork publication succeeded
but synchronization failed, rerun the notification job or dispatch the sync
workflow with the explicit published fork tag. The updater reuses the pin PR
branch; maintainers still review and merge the PR.

For a manual cpi publishing retry, select the original tag as the registry
workflow's ref and enable its publishing input. Existing package versions and
GitHub assets must match the verified bytes. Never replace assets, move a pushed
tag, or republish different bytes under an existing version. If verification
detects a content conflict, fix the source and push a new release tag.
