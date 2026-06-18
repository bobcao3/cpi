# caveman-micro

A Pi extension that toggles the [caveman-micro](https://github.com/kuba-guzik/caveman-micro) token-compression prompt on/off.

## What it does

When enabled, the caveman-micro prompt is appended to the system prompt on every turn. The model responds in terse, fragment-style prose — dropping articles, pleasantries, and hedging while preserving all technical accuracy.

Caveman mode is **on by default** for new sessions. A rock indicator (🪨) is shown on the footer's extension-status line while enabled.

> **Why a status line?** pi allows only one custom footer at a time (`ctx.ui.setFooter` replaces rather than stacks). Owning the footer here collided with the `shell` extension's footer, so one indicator always silently lost. `ctx.ui.setStatus()` is rendered by whatever footer is active (built-in or custom), so the marker coexists with other extensions with no ownership conflict.

## Install

This extension is intended to live in a Pi extension directory, e.g.:

```bash
# Global (all projects)
cp -r caveman-micro ~/.pi/agent/extensions/

# Project-local
cp -r caveman-micro .pi/extensions/
```

Then restart pi or run `/reload`.

## Usage

| Command           | Action             |
| ----------------- | ------------------ |
| `/caveman`        | Toggle on/off      |
| `/caveman on`     | Enable explicitly  |
| `/caveman off`    | Disable explicitly |
| `/caveman status` | Show current state |

## Footer indicator

When caveman is on, the footer's extension-status line shows `🪨`, e.g.:

```
~/project (main)
0.0%/200k (auto)                  (provider) model-id • high
🪨
```

When off, the indicator is cleared.

## Mid-conversation warning

If you toggle caveman while a conversation is in progress, an explicit user message is injected so the model receives a strong in-context instruction. Prior turns remain in their original style.

## Files

```
caveman-micro/
├── index.ts           # Extension logic
├── caveman-micro.yaml # Prompt text (read at runtime)
└── README.md
```

## State persistence

The toggle state is persisted to the session via `pi.appendEntry()` and restored on:

- Session start (startup, new, resume, fork)
- `/reload`
- Tree navigation (`/tree`)
