# cpi

Install the public CLI package:

```sh
npm install --global @bobcao3/cpi
cpi
```

Alternatively, install with Bun:

```sh
bun install --global @bobcao3/cpi
cpi
```

Install the current repository source instead of the npm release with:

```sh
bun install --global bobcao3/cpi
```

For a script-free GitHub install with npm, use npm 12 or newer:
`npm install --global --ignore-scripts --allow-git=root bobcao3/cpi`.

GitHub installs run the repository's CLI and extensions and use published native
assets. They are installed snapshots; use the editable setup below to work on a
local checkout. First-party packages have no installation lifecycle scripts;
installation also works with `--ignore-scripts`. The package manager selects the
native Ghostmux package; Tree-sitter WASM is a regular dependency. Pi
dependencies alias the published fork packages, not upstream releases. Git and
JJ remain external programs.

The POSIX shell entrypoint selects Node for npm installations and Bun for Bun
installations. The launcher resolves installation symlinks and inspects the
enclosing installation's metadata, without consulting the current project's
lockfiles. The launcher defaults to Node when installation metadata is absent.
Node must satisfy `engines.node` in the package manifest when selected.

Set `CPI_RUNTIME=node`, `CPI_RUNTIME=bun`, or `CPI_RUNTIME=deno` to override
detection for copied packages or installations with ambiguous metadata. The
launcher also detects Deno's local `node_modules/.deno` installation metadata.
Deno's global installer creates its own JavaScript-module wrapper and does not
use this POSIX shell entrypoint. The shell entrypoint requires a POSIX host with
`readlink`; native Windows installation is unsupported.

## Editable development install

From the checkout root:

```sh
bun run install:dev
cpi --version
```

Ensure the directory printed by `bun pm bin --global` is on `PATH`. To choose
another directory, use `BUN_INSTALL_BIN="$HOME/.local/bin" bun run install:dev`.
Rerun after moving the checkout to update Bun's source link.

CLI and supporting-tool JavaScript/TypeScript edits apply on the next invocation
without a build. Native Ghostmux and WASM source changes require their packages'
build scripts. For extension and TOML prompt edits in a running session, use
`/reload`. See the repository's
[editable-development policy](https://github.com/bobcao3/cpi/blob/main/AGENTS.md#editable-development)
for working directly against the Pi fork.

## SDK

Import `@bobcao3/cpi` for cpi's CLI and session defaults. Import
`@bobcao3/cpi/bootstrap` before any separate Pi imports. The package includes
TypeScript declarations.

```ts
import { createAgentSession, SessionManager } from "@bobcao3/cpi";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
try {
  await session.prompt("Describe this project.");
} finally {
  session.dispose();
}
```

The package manifest controls application identity and update policy. Ghostmux
and Tree-sitter ship their verified assets with the release. Other shell-tool
provisioning and provider calls can require network access. Native-component
notices are distributed by their owning tool packages.
