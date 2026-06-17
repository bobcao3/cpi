# caveman-micro

A Pi extension that toggles the [caveman-micro](https://github.com/kuba-guzik/caveman-micro) token-compression prompt on/off.

## What it does

When enabled, the caveman-micro prompt is appended to the system prompt on every turn. The model responds in terse, fragment-style prose — dropping articles, pleasantries, and hedging while preserving all technical accuracy.

Caveman mode is **on by default** for new sessions. A small rock indicator (🪨) is appended to the model string in the footer, so it does not use a separate status line.

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

When caveman is on, the footer model string shows a `🪨` suffix, e.g.:

```
(provider/model • high 🪨)
```

When off, the default footer is restored with no caveman indicator.

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
