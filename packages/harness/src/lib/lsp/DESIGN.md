# cpi LSP subsystem — design

## Sources of truth

- Lifecycle: [`manager.ts`](manager.ts), [`session.ts`](session.ts).
- Discovery and language support: [`discover.ts`](discover.ts),
  [`registry.ts`](registry.ts).
- Provisioning: [`provision.ts`](provision.ts) (resolution policy),
  [`install.ts`](install.ts) (per-language installers), [`zls.ts`](zls.ts) (zls
  release matching), [`release.ts`](release.ts) (release fetch, verification,
  extraction).
- Transport: [`worker.mjs`](worker.mjs).
- Diagnostics: [`diagnostics.ts`](diagnostics.ts),
  [`diagnostics-overflow.ts`](diagnostics-overflow.ts).
- Tool: [`../../lsp.ts`](../../lsp.ts).
- Integration: [`../../shell/tools.ts`](../../shell/tools.ts),
  [`../../shell/lsp-hook.ts`](../../shell/lsp-hook.ts),
  [`../../llm-editor/lsp.ts`](../../llm-editor/lsp.ts).
- Configuration: [`../config.ts`](../config.ts),
  [`../../../cpi-config.default.json`](../../../cpi-config.default.json).
- Model-facing guidance: [`../../text/lsp.toml`](../../text/lsp.toml).

## Design rationale

- **One live server per language and project root.** This shares initialization
  while isolating unrelated projects and toolchains.
- **Environment-first resolution.** A caller-provided project environment is
  more authoritative than a harness-managed installation.
- **Per-file diagnostics.** One protocol path is predictable across languages;
  package-wide checks remain explicit ecosystem commands.
- **Read-only editor views do not start LSPs.** Installing or spawning during a
  view would add latency without validating a write.
- **Generic worker transport.** Language-specific policy belongs in the registry
  and provisioning layers, not duplicated transports.
- **Verified provisioning.** Download verification policy belongs beside the
  downloader so the enforcement and fallback cannot drift apart.
- **zls version matching.** zls embeds one Zig version, so the build is selected
  from the project's Zig pin (`.zigversion`, else `build.zig.zon`'s
  `.minimum_zig_version`), then the local `zig`, then config, and the version
  query is answered by the zigtools release worker rather than by tag matching.
