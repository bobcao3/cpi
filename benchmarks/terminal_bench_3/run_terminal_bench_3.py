#!/usr/bin/env python3
"""Run TerminalBench 3.0 through Harbor against an OpenAI-compatible endpoint.

Targets SGLang-style /v1 endpoints, but works with any endpoint that speaks the
OpenAI chat-completions API.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_TB3_URL = "https://github.com/harbor-framework/terminal-bench-3.git"
DEFAULT_TASKS_PATH = "./terminal-bench-3/tasks"
DEFAULT_JOBS_DIR = "./jobs"
DEFAULT_AGENT = "terminus-2"
DEFAULT_CONTEXT_WINDOW = 128000
DEFAULT_MAX_OUTPUT_TOKENS = 8192


def run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def ensure_uv() -> None:
    if shutil.which("uv") is None:
        print(
            "error: 'uv' is required but not found.\n"
            "Install it from https://docs.astral.sh/uv/",
            file=sys.stderr,
        )
        sys.exit(1)


def ensure_tb3(tasks_path: Path, force_clone: bool) -> None:
    repo_dir = tasks_path.parent
    if force_clone and repo_dir.exists():
        print(f"Removing existing {repo_dir} (--force-clone)")
        shutil.rmtree(repo_dir)
    if not tasks_path.exists():
        repo_dir.mkdir(parents=True, exist_ok=True)
        print(f"Cloning TerminalBench 3.0 into {repo_dir}")
        run(["git", "clone", DEFAULT_TB3_URL, str(repo_dir)])
    if not tasks_path.exists():
        print(f"error: tasks path not found: {tasks_path}", file=sys.stderr)
        sys.exit(1)


def build_config(args: argparse.Namespace) -> str:
    jobs_dir = Path(args.jobs_dir).resolve()
    lines: list[str] = [
        f"job_name: {args.job_name}",
        f"jobs_dir: {jobs_dir}",
        f"n_attempts: {args.n_attempts}",
        "agents:",
        f"  - name: {args.agent}",
        f"    model_name: openai/{args.model}",
        "    kwargs:",
        f"      api_base: {args.endpoint}",
        f"      temperature: {args.temperature}",
        "      model_info:",
        f"        max_input_tokens: {args.context_window}",
        f"        max_output_tokens: {args.max_output_tokens}",
        "        input_cost_per_token: 0.0",
        "        output_cost_per_token: 0.0",
        "datasets:",
    ]
    if args.dataset:
        if "@" in args.dataset:
            ds_name, ds_version = args.dataset.split("@", 1)
            lines.extend([f"  - name: {ds_name}", f"    version: {ds_version}"])
        else:
            lines.append(f"  - name: {args.dataset}")
    else:
        lines.append(f"  - path: {Path(args.tasks_path).resolve()}")
    if args.task_name:
        lines.append("    task_names:")
        for name in args.task_name:
            lines.append(f"      - {name}")
    if args.exclude_task_name:
        lines.append("    exclude_task_names:")
        for name in args.exclude_task_name:
            lines.append(f"      - {name}")
    if args.max_tasks is not None:
        lines.append(f"    n_tasks: {args.max_tasks}")
    lines.extend([
        "environment:",
        "  type: docker",
        "orchestrator:",
        f"  n_concurrent_trials: {args.n_concurrent}",
        "  retry:",
        "    max_retries: 2",
        "    wait_multiplier: 2.0",
        "    min_wait_sec: 10.0",
        "    max_wait_sec: 300.0",
    ])
    return "\n".join(lines) + "\n"


def default_job_name(model: str) -> str:
    safe = model.replace("/", "-").replace(":", "-") or "model"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"tb3-{safe}-{stamp}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run TerminalBench 3.0 against an OpenAI-compatible endpoint (e.g. SGLang).",
    )
    parser.add_argument(
        "--endpoint",
        required=True,
        help="OpenAI-compatible base URL, e.g. http://localhost:30000/v1",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("OPENAI_API_KEY"),
        help="API key for the endpoint. Defaults to OPENAI_API_KEY env var.",
    )
    parser.add_argument(
        "--model",
        required=True,
        help="Model name served by the endpoint, e.g. Qwen/Qwen3-8B",
    )
    parser.add_argument(
        "--dataset",
        help="Use a published Harbor dataset (e.g. terminal-bench@3.0) instead of the local clone.",
    )
    parser.add_argument(
        "--tasks-path",
        default=DEFAULT_TASKS_PATH,
        help=f"Path to local TB3 tasks directory. Default: {DEFAULT_TASKS_PATH}",
    )
    parser.add_argument(
        "--agent",
        default=DEFAULT_AGENT,
        help=f"Harbor agent to use. Default: {DEFAULT_AGENT}",
    )
    parser.add_argument(
        "--job-name",
        default=None,
        help="Job name for the Harbor run.",
    )
    parser.add_argument(
        "--jobs-dir",
        default=DEFAULT_JOBS_DIR,
        help=f"Directory for Harbor job outputs. Default: {DEFAULT_JOBS_DIR}",
    )
    parser.add_argument(
        "--n-concurrent",
        type=int,
        default=1,
        help="Number of concurrent trials. Default: 1",
    )
    parser.add_argument(
        "--n-attempts",
        type=int,
        default=1,
        help="Attempts per task. Default: 1",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=None,
        help="Limit number of tasks to run.",
    )
    parser.add_argument(
        "--task-name",
        action="append",
        help="Include task name/pattern (repeatable).",
    )
    parser.add_argument(
        "--exclude-task-name",
        action="append",
        help="Exclude task name/pattern (repeatable).",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.7,
        help="Sampling temperature. Default: 0.7",
    )
    parser.add_argument(
        "--context-window",
        type=int,
        default=DEFAULT_CONTEXT_WINDOW,
        help=f"Model context window. Default: {DEFAULT_CONTEXT_WINDOW}",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=DEFAULT_MAX_OUTPUT_TOKENS,
        help=f"Model max output tokens. Default: {DEFAULT_MAX_OUTPUT_TOKENS}",
    )
    parser.add_argument(
        "--force-clone",
        action="store_true",
        help="Re-clone the TerminalBench 3.0 repository even if it exists.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Write config and print command without running.",
    )
    args = parser.parse_args()
    if not args.api_key:
        parser.error("--api-key or OPENAI_API_KEY environment variable is required")
    if args.job_name is None:
        args.job_name = default_job_name(args.model)
    return args


def main() -> int:
    args = parse_args()
    ensure_uv()
    project_dir = Path(__file__).parent.resolve()
    if not args.dry_run:
        ensure_tb3(Path(args.tasks_path), args.force_clone)
    config_text = build_config(args)
    config_path = project_dir / args.jobs_dir / f"{args.job_name}.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(config_text)
    print(f"Wrote Harbor job config: {config_path}")
    env = os.environ.copy()
    env["OPENAI_API_KEY"] = args.api_key
    cmd = [
        "uv", "run", "--directory", str(project_dir),
        "harbor", "run", "--config", str(config_path),
    ]
    if args.dry_run:
        print("Dry run. To execute, run:")
        print(" ".join(cmd))
        return 0
    run(cmd, env=env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
