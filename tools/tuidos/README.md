# tuidos

Local-first task tracking with one SQLite-backed data model; `clidos` is the CLI
and `tuidos` is the HTMX 4 browser interface.

## Run

Bun 1.4 or newer is required.

```bash
bun install
bun start
bun dev
bun run clidos
```

The browser interface is available at `https://localhost:3443` by default.

Run `tuidos --help` for launcher options. See [DESIGN.md](DESIGN.md) and the
source for architecture and implementation details.
