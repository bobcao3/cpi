# TerminalBench 3.0 benchmark runner

Runs [TerminalBench 3.0](https://github.com/harbor-framework/terminal-bench-3) using the official [Harbor](https://github.com/harbor-framework/harbor) harness against an arbitrary SGLang/OpenAI-compatible endpoint.

## Requirements

- [uv](https://docs.astral.sh/uv/)
- [Docker](https://docs.docker.com/get-started/get-docker/) (including the Docker Compose plugin) running
- An OpenAI-compatible endpoint (e.g. SGLang, vLLM, llama.cpp server)

## Quick start

```bash
cd benchmarks
uv run run_terminal_bench_3.py \
  --endpoint http://localhost:30000/v1 \
  --api-key sk-dummy \
  --model Qwen/Qwen3-8B \
  --n-concurrent 4
```

If the endpoint requires no authentication, any non-empty API key works.

## How it works

1. Ensures `uv` is installed.
2. Installs the `harbor` package in the local uv project environment.
3. Clones `harbor-framework/terminal-bench-3` into `terminal-bench-3/` (skipped with `--dataset`).
4. Generates a Harbor `JobConfig` YAML that points the default `terminus-2` agent at your endpoint.
5. Runs `harbor run --config <cfg>` with `OPENAI_API_KEY` exported.

Results are written to `./jobs/<job-name>/`.

## Common options

| Option                         | Description                                                             |
| ------------------------------ | ----------------------------------------------------------------------- |
| `--max-tasks N`                | Run only the first N tasks (useful for smoke tests).                    |
| `--task-name PATTERN`          | Include only tasks matching a glob pattern (repeatable).                |
| `--exclude-task-name PATTERN`  | Exclude tasks matching a glob pattern (repeatable).                     |
| `--dataset terminal-bench@3.0` | Use a published Harbor dataset instead of the local TB3 clone.          |
| `--dry-run`                    | Write the config YAML and print the command without executing.          |
| `--force-clone`                | Re-clone the TB3 repository even if `terminal-bench-3/` already exists. |

## Example: single-task smoke test

```bash
uv run run_terminal_bench_3.py \
  --endpoint http://localhost:30000/v1 \
  --api-key sk-dummy \
  --model Qwen/Qwen3-8B \
  --task-name hello-world
```

## Monitoring a run

The main `uv run` process buffers output. For live, readable progress use the monitor script:

```bash
# Show last 10 steps from the most recent job
python3 monitor_tb3.py -n 10

# Watch continuously, updating every 10 seconds
python3 monitor_tb3.py -n 5 --watch

# Watch a specific job
python3 monitor_tb3.py --job tb3-moonshotai-Kimi-K2.7-Code-20260618-010447 -n 10 --watch
```

Other useful logs:

```bash
# Agent action stream (raw keystrokes and observations)
tail -f jobs/<job-name>/job.log

# Environment/orchestrator messages
tail -f jobs/<job-name>/<task-name>/trial.log

# Asciinema-style terminal recording of the agent session
asciinema play jobs/<job-name>/<task-name>/agent/recording.cast

# Overall job status
cat jobs/<job-name>/result.json
```

## Known issues and mitigations

### tmux session failures under high concurrency (cold cache)

When running many tasks concurrently with uncached Docker images, the Docker
daemon can become overloaded during simultaneous image builds. This causes
`docker compose exec` calls (used for tmux installation and session creation)
to fail with `Failed to start tmux session. Error: None`.

**Root cause:** Docker daemon overload during concurrent cold-start builds.
Harbor also has a bug where `stderr` is always `None` (merged into `stdout`
via `asyncio.subprocess.STDOUT`), hiding the actual error.

**Mitigations:**
1. **Pre-build images** — run `harbor run --agent oracle --max-tasks 0` first
   to cache all Docker images, then run the real evaluation.
2. **Retries** — the generated config includes `max_retries: 2` with
   exponential backoff to handle transient `docker compose exec` failures.
3. **Reduce concurrency for first run** — use `--n-concurrent 4` when images
   are uncached, then increase to 8+ for subsequent runs.

See: [harbor-framework/harbor#1657](https://github.com/harbor-framework/harbor/pull/1657),
[docker/compose#6198](https://github.com/docker/compose/issues/6198).
