# caveman-micro

A Pi extension that toggles the [caveman-micro](https://github.com/kuba-guzik/caveman-micro) token-compression prompt on/off.

## What it does

When enabled, the caveman-micro prompt is appended to the system prompt on every turn. The model responds in terse, fragment-style prose — dropping articles, pleasantries, and hedging while preserving all technical accuracy.

Caveman mode is **off by default** for new sessions. A rock indicator (🪨) is shown flush-right on footer line 1 while enabled.

> **Why footer line 1?** The cpi footer (`extensions/lib/footer.ts`) is the single owner of pi's custom footer and exposes `registerRightSegment` for flush-right indicators on line 1. Putting `🪨` there keeps it visible regardless of cwd length and coexists with other line-1 segments (branch, shell bg count) under the one owner — no `setFooter` collision, no separate status line.

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

When caveman is on, footer line 1 shows `🪨` flush-right, e.g.:

```
~/project (main)                                          🪨
0.0%/200k (auto)                  (provider) model-id • high
```

When off, the indicator is cleared (the segment produces nothing).

## Mid-conversation warning

If you toggle caveman while a conversation is in progress, an explicit user message is injected so the model receives a strong in-context instruction. Prior turns remain in their original style.

## State persistence

The toggle state is persisted to the session via `pi.appendEntry()` and restored on:

- Session start (startup, new, resume, fork)
- `/reload`
- Tree navigation (`/tree`)
