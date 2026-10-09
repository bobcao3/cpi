# 50 reader questions for cpi

Use these questions as audit lenses and as writing targets. They overlap on
purpose: overlap reveals which fact needs one authoritative home. Adapt names
and paths to the checkout under audit; keep the count and the coverage.

Each question carries its intended home — the document and section a reader
should reach without skipping unrelated material. When no home exists, that
absence is the finding: propose the doc and its audience, or cite the code that
already answers the question.

## A. Orientation — what is this?

1. What is cpi in one sentence I can repeat to a colleague? — home: `README.md`,
   first screen.
2. What are Pi, the Pi fork, and cpi, and which repository owns which code? —
   home: `docs/package-boundary.md`, opening.
3. What does cpi add over upstream Pi, and what is deliberately left out? —
   home: `README.md`; the authoritative feature list is `packages/extensions/`.
4. What are the moving parts at runtime, and which process talks to which? —
   home: `docs/package-boundary.md`, prose; the tree itself is the filesystem.
5. Which packages are first-party and which are pinned fork or third-party
   artifacts? — home: `docs/package-boundary.md`; pins in
   `vendor/pi/manifest.json`.
6. What is the license, and what must I ship when redistributing? — home:
   `README.md` plus `LICENSE` and `packages/extensions/NOTICE.md`.
7. How do I tell whether a behavior comes from the pinned Pi artifact set or
   from cpi extension code? — home: `docs/package-boundary.md`, package boundary.

## B. Install, configure, operate

8. What runtimes and versions must exist before cpi runs? — home:
   `packages/cli/README.md`; engine pins live in the manifests.
9. What is the shortest path from a fresh checkout to a running `cpi`? — home:
   `packages/cli/README.md`, editable development install.
10. Which installation modes exist (registry, GitHub, editable source link),
    and which one do I want? — home: `packages/cli/README.md`, install
    sections.
11. How do I keep a checkout on PATH, and what must I rerun after moving it? —
    home: `packages/cli/README.md`, editable development install.
12. How do I run `cpi` against local Pi fork sources instead of pinned
    artifacts? — home: `AGENTS.md`, editable development.
13. Where do configuration files live, how are they merged, and which one
    wins? — home: `docs/using-cpi.md`, configuration pointer; keys in
    `cpi-config.default.json`.
14. Where do sessions, logs, caches, and shell state live, and with what
    permissions? — home: `docs/storage.md`; authorities are `getAgentDir`
    and `PI_SESSION_DIR` in code.
15. What happens on a machine where the ghostmux binary or shell helpers are
    missing? — home: `packages/ghostmux/README.md`; the provisioning path is
    code.

## C. Shells and background work

16. How does the `sh` tool decide to background a command, and what does it
    return? — home: `extensions/text/shell.toml` is model-facing; a human
    summary belongs in `docs/background-work.md`.
17. What is the lifecycle of a background shell from launch to completion
    notification? — home: `docs/background-work.md`.
18. How do I signal, kill, or detach a background shell, and what changes
    after detach? — home: `docs/background-work.md`.
19. What survives restart, reload, or crash: shells, monitors, notifications,
    records? — home: `docs/background-work.md` plus `docs/activity-browser.md`.
20. How do I wait for events without polling, and what wakes the agent? —
    home: `docs/session-events.md`; model-facing rules live in the
    `wait_any` and `alarm` tool text.
21. How do repeat monitors differ from background shells, and how do they
    stop? — home: `docs/background-work.md`.
22. What limits apply to shell output, waitfor, and logs, and where do they
    live? — home: `cpi-config.default.json`; docs link, never copy.
23. What happens to running background work at session shutdown? — home:
    `docs/background-work.md`, stated as a contract.
24. How do I inspect running work: footer counters, the activity browser,
    `sh_background_ps`? — home: `docs/activity-browser.md`.

## D. Agent features

25. How do I delegate to a subagent, resume it, and what are the launcher
    rules? — home: `skills/subagents-in-pi/SKILL.md`.
26. What does compaction preserve and restore, and how do I verify a
    compaction? — home: `docs/using-cpi.md`, compaction; authorities are the
    compaction sources.
27. What wakes an idle agent: alarms, completions, external events,
    anti-stuck? — home: `docs/session-events.md`;
    `docs/external-event-subscriptions.md` covers producers only.
28. How do goals and their budgets work? — home: `docs/goals.md`.
29. How do I use the LLM editor tools, and what are their limits? — home: `docs/editor-tools.md`; model-facing rules in `extensions/text/`.
30. How do LSP sessions start, lint, and react to shell edits? — home: `docs/lsp.md`; keys in `cpi-config.default.json`.
31. Where does cost data come from, and where is it reported? — home: out of
    scope; the ledger (`lib/cost-ledger.ts`) is the authority.
32. How do external services push events into a session without running an
    agent loop? — home: `docs/external-event-subscriptions.md`.

## E. cpi codebase: extensions, skills, docs

33. Where in the tree do I change a given behavior: tool text, tool logic, a
    skill, or the CLI? — home: `README.md` and `AGENTS.md`.
34. Why must model-facing text live in `extensions/text/*.toml`, and how is it
    rendered? — home: `AGENTS.md`, coding rules.
35. How does extension hot reload work, and what must not be cached across
    reloads? — home: `AGENTS.md`, developing extensions.
36. When may an extension rewrite the system prompt, and when is tool text the
    right home? — home: `AGENTS.md`, prompt-transform rule.
37. How do workers and bin scripts find the active host Pi? — home:
    `AGENTS.md`, peer-packages rule; the loader is `bin/host-pi.mjs`.
38. Which source metrics are enforced (file lines, statements, comment share),
    and how do I run them? — home: `AGENTS.md`, coding rules; commands in the
    root `package.json`.
39. How do I add a skill, and how are skills discovered, routed, and
    disabled? — home: `$PI_AGENT_SRC/docs/skills.md`; wiring in
    `packages/extensions/package.json`.
40. How do I run checks, formatting, and integration scripts, and which honor
    `CPI_FORK`? — home: `AGENTS.md`, development and verification.
41. How should a new tool render, given the tool-tree presentation contract? —
    home: `docs/tool-tree-presentation-design.md`.

## F. Pi fork: development, artifacts, interfaces

42. What does the fork change relative to upstream Pi, and where is the pinned
    provenance recorded? — home: `vendor/pi/manifest.json` provenance; fork
    `README.md` for the change summary.
43. How do I build, check, and test the fork itself? — home: fork `AGENTS.md`
    and `CONTRIBUTING.md`.
44. How are fork artifacts built, versioned, signed, and released? — home:
    `packages/cli/registry-release.md`; the artifact workflow belongs to the fork.
45. How do I bump the pinned artifact set, and what must be refreshed with
    it? — home: `AGENTS.md`, published packages; procedure in
    `packages/cli/registry-release.md`.
46. How do consumers drive Pi outside the TUI: print or JSON mode, RPC, the
    SDK? — home: `$PI_AGENT_SRC/docs/cli.md`, `rpc.md`, `sdk.md`.
47. How do I test an unpublished fork change against cpi before pinning it? —
    home: `AGENTS.md`, editable development.

## G. Contracts and limits

48. What are the harness-wide capacity limits (background shells, subagents,
    activity entries, output sizes)? — home: one limits summary; authorities
    are config defaults and code.
49. What is the ghostmux wire contract, and what happens on protocol errors or
    timeouts? — home: `packages/ghostmux/README.md`.
50. Which APIs do SDK consumers get, and where are their signatures? — home:
    `packages/cli/README.md`, SDK section; declarations are the authority.

## Using the list

- Trace one question at a time from the entry point a real reader would use;
  record the path, the first answer location, and the skip cost.
- When two questions are answered by one passage, that passage is probably
  misplaced unless the questions share an audience.
- When a question has no home, decide whether to answer it or declare it out
  of scope, then write the answer in its home; silence is a finding either
  way.
