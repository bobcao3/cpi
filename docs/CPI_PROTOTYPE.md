# cpi package boundary

The cpi application and the Pi fork are independent repositories connected by
versioned, installed packages. cpi must not import a neighboring Pi checkout.
The exact fork artifact set is recorded in `vendor/pi/manifest.json`.

The [CLI](../packages/cli/src/index.ts) owns application bootstrap, SDK entry,
and VCS policy. Its [bootstrap](../packages/cli/bootstrap.mjs) must run before
Pi imports. [Resource loading](../packages/cli/src/resources.ts) connects the
[extensions package](../packages/extensions/package.json) to the installed SDK.
Extensions use host-provided Pi peers; standalone workers use the
[host-loading interface](../packages/extensions/bin/host-pi.mjs).

The footer uses the public extension API rather than inspecting the TUI tree.
See [VCS policy](../packages/cli/VCS.md). Supporting tools own their builds and
artifact verification independently of the extensions package.

## Verification

```sh
npm run check
node packages/cli/scripts/check-boundaries.mjs
node packages/cli/scripts/package.mjs /tmp/cpi-artifact
node packages/cli/scripts/verify-installed.mjs /tmp/cpi-artifact
```

Installed verification must run without either source checkout or development
symlinks. It exercises CLI startup, SDK consumption, workers, reload, replay,
HTML export, rendering, and tool/schema transport without paid model requests.
See the [release procedure](../packages/cli/RELEASE.md) for the current artifact
format, provenance, and optional live-terminal checks. Report npm and Bun
installation results separately; success with one does not prove the other.
