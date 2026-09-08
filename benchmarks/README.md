# TerminalBench 3.0 benchmark runner

Runs [TerminalBench 3.0](https://github.com/harbor-framework/terminal-bench-3)
using the official [Harbor](https://github.com/harbor-framework/harbor) harness
against an arbitrary SGLang/OpenAI-compatible endpoint.

## Requirements

- [uv](https://docs.astral.sh/uv/)
- [Docker](https://docs.docker.com/get-started/get-docker/) (including the
  Docker Compose plugin) running
- An OpenAI-compatible endpoint (e.g. SGLang, vLLM, llama.cpp server)

## Quick start

Use the executable help for runner usage and options:

[`uv run terminal_bench_3/run_terminal_bench_3.py --help`](terminal_bench_3/run_terminal_bench_3.py)

Use the executable help for monitoring usage and options:

[`python3 terminal_bench_3/monitor_tb3.py --help`](terminal_bench_3/monitor_tb3.py)

The [runner implementation](terminal_bench_3/run_terminal_bench_3.py) invokes
Harbor, and the [monitor implementation](terminal_bench_3/monitor_tb3.py)
reports run progress.

## Known issues and mitigations

### tmux session failures under high concurrency (cold cache)

When running many tasks concurrently with uncached Docker images, the Docker
daemon can become overloaded during simultaneous image builds. This causes
`docker compose exec` calls (used for tmux installation and session creation) to
fail with `Failed to start tmux session. Error: None`.

**Root cause:** Docker daemon overload during concurrent cold-start builds.
Harbor also has a bug where `stderr` is always `None` (merged into `stdout` via
`asyncio.subprocess.STDOUT`), hiding the actual error.

**Mitigations:**

1. **Pre-build images** before the evaluation to warm the Docker image cache.
2. **Lower concurrency** during the initial cold-cache run, then increase it
   after the images are cached.

See:
[harbor-framework/harbor#1657](https://github.com/harbor-framework/harbor/pull/1657),
[docker/compose#6198](https://github.com/docker/compose/issues/6198).
