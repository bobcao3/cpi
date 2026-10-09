# cpi package boundary

Three names appear in every cpi discussion: **upstream Pi** is the public agent
harness; the **Pi fork** is the Pi build that cpi consumes; **cpi** is this
repository — the CLI, extensions, skills, and supporting tools layered on the
pinned fork packages. The two repositories never import each other; the exact
pinned artifact set is recorded in `vendor/pi/manifest.json`.

Tree layout and tool presentation belong to cpi. The
[tree implementation](../packages/extensions/extensions/tree/index.ts) and
[presentation services](../packages/extensions/extensions/presentation/index.ts)
own tree interaction, inspection, animation, styling, and HTML rendering.
Pi supplies generic execution snapshots and component-rendering hooks. Pi must
not import cpi's renderer or expose cpi's tree model. The
[extension adapter](../packages/extensions/extensions/lib/tree-api.ts) connects
cpi renderers to the host without moving presentation policy into Pi.

Attribute behavior by package: anything imported from `@earendil-works/**` is
the pinned Pi set (agent loop, TUI, providers, SDK), while `packages/cli/**`,
`packages/extensions/**`, and the supporting tool packages are cpi. At runtime
the CLI hosts extensions in one process, background shells run in Ghostmux
daemons, and subagents run in worker processes.

The [CLI](../packages/cli/src/index.ts) owns application bootstrap, SDK entry,
and VCS policy. Its [bootstrap](../packages/cli/bootstrap.mjs) must run before
Pi imports. [Resource loading](../packages/cli/src/resources.ts) connects the
[extensions package](../packages/extensions/package.json) to the installed SDK.
Extensions use host-provided Pi peers; standalone workers use the
[host-loading interface](../packages/extensions/bin/host-pi.mjs).

The footer uses the public extension API rather than inspecting the TUI tree.
See [adding a VCS adapter](../packages/cli/adding-a-vcs-adapter.md). Supporting
tools own their builds and artifact verification independently of the
extensions package.

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
See the [registry release procedure](../packages/cli/registry-release.md) for
the current artifact format, provenance, and optional live-terminal checks.
Report npm and Bun
installation results separately; success with one does not prove the other.
