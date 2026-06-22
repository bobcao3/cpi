# tuidos

Local-first task tracking. One SQLite-backed data model (in `src/core`), two
clients that read and write the same files:

- `clidos` — the non-TTY CLI.
- `tuidos` — the interactive TUI (OpenTUI / Solid).

State lives under `~/.local/state/tuidos` (override with `TUIDOS_STATE_DIR`).
See `DESIGN.md` for the two-tier schema and `docs/data_model/` for the tables.

## Run

```bash
bun install

bun dev            # the TUI (watch)
bun run tui        # the TUI, once
bun run clidos     # the CLI
```

The TUI is keyboard-driven; `?` shows the keymap for the active view, and the
status bar lists the keys that work right now. The board is the main surface:
move with `h/j/k/l`, open a card with enter, create with `n`, move a card
across columns with `H`/`L`, toggle done with `d`.
