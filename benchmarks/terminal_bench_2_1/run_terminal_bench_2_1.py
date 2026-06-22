#!/usr/bin/env python3
"""Run TerminalBench 2.1 through Harbor against an OpenAI-compatible endpoint.

Supports model-specific configurations for reasoning models like Kimi K2.7-Code
and GLM-5.2, including thinking mode, reasoning_effort, and chat_template_kwargs.

Two agent kinds:
  --agent terminus-2 (default): Harbor's built-in terminus-2 agent.
  --agent cpi                 : pi + cpi harness (see harbor_agents/cpi_pi.py).
    Endpoint/model/provider/cpi-ref are CLI-driven; cpi is git-cloned into the
    container, no pi-exa (no web search), caveman-micro on by default.

Usage examples:

  # terminus-2, Kimi K2.7-Code
  python run_terminal_bench_2_1.py \\
      --endpoint https://sglang-kimi-k27-code-b200.onca-snapper.ts.net/v1 \\
      --model moonshotai/Kimi-K2.7-Code \\
      --n-concurrent 4

  # cpi harness, single-task smoke test
  python run_terminal_bench_2_1.py \\
      --agent cpi \\
      --endpoint https://sglang-kimi-k27-code-b200.onca-snapper.ts.net/v1 \\
      --model moonshotai/Kimi-K2.7-Code \\
      --task-name hello-world --max-tasks 1 --n-concurrent 1
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_TB21_REPO = "https://github.com/harbor-framework/terminal-bench-2-1.git"
DEFAULT_TB21_DATASET = "terminal-bench/terminal-bench-2-1"
DEFAULT_TASKS_PATH = "./terminal-bench-2-1/tasks"
DEFAULT_JOBS_DIR = "./jobs"
DEFAULT_AGENT = "terminus-2"
DEFAULT_N_CONCURRENT = 4
DEFAULT_PROVIDER = "tb21"
DEFAULT_CPI_REPO = "https://github.com/bobcao3/cpi.git"


def run(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, env=env, check=True)


def ensure_tb21(tasks_path: Path, force_clone: bool) -> None:
    """Clone TB2.1 repo if tasks not present."""
    repo_dir = tasks_path.parent
    if force_clone and repo_dir.exists():
        print(f"Removing existing {repo_dir} (--force-clone)")
        import shutil
        shutil.rmtree(repo_dir)
    if not tasks_path.exists():
        repo_dir.parent.mkdir(parents=True, exist_ok=True)
        print(f"Cloning TerminalBench 2.1 into {repo_dir}")
        try:
            run(["git", "clone", DEFAULT_TB21_REPO, str(repo_dir)])
        except subprocess.CalledProcessError:
            # Another process may have cloned it concurrently
            if not tasks_path.exists():
                raise
    if not tasks_path.exists():
        print(f"error: tasks path not found: {tasks_path}", file=sys.stderr)
        sys.exit(1)


def build_config(args: argparse.Namespace, project_dir: Path) -> str:
    """Build Harbor YAML config from CLI args."""
    jobs_dir = (project_dir / args.jobs_dir).resolve()
    lines: list[str] = [
        f"job_name: {args.job_name}",
        f"jobs_dir: {jobs_dir}",
        f"n_attempts: {args.n_attempts}",
        "agents:",
    ]
    lines.extend(_agent_block(args))
    lines.extend(_dataset_block(args))
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


def _agent_block(args: argparse.Namespace) -> list[str]:
    """Build the agents list block for the chosen agent kind."""
    if args.agent == "cpi":
        return _cpi_agent_block(args)
    return _terminus_agent_block(args)


def _terminus_agent_block(args: argparse.Namespace) -> list[str]:
    """terminus-2 agent block (original behavior)."""
    lines: list[str] = [
        f"  - name: {args.agent}",
        f"    model_name: openai/{args.model}",
        "    kwargs:",
        f"      api_base: {args.endpoint}",
        f"      temperature: {args.temperature}",
    ]
    if args.reasoning_effort:
        lines.append(f"      reasoning_effort: {args.reasoning_effort}")
    if args.interleaved_thinking:
        lines.append("      interleaved_thinking: true")
    lines.extend([
        "      model_info:",
        f"        max_input_tokens: {args.max_input_tokens}",
        f"        max_output_tokens: {args.max_output_tokens}",
        "        input_cost_per_token: 0.0",
        "        output_cost_per_token: 0.0",
    ])
    llm_kwargs: dict[str, Any] = {}
    if args.top_p is not None:
        llm_kwargs["top_p"] = args.top_p
    if llm_kwargs:
        lines.append("      llm_kwargs:")
        for k, v in llm_kwargs.items():
            lines.append(f"        {k}: {v}")
    if args.chat_template_kwargs:
        parts = [p.strip() for p in args.chat_template_kwargs.split(",")]
        ct_kwargs = dict(p.split("=", 1) for p in parts)
        lines.extend([
            "      llm_call_kwargs:",
            "        extra_body:",
            "          chat_template_kwargs:",
        ])
        for k, v in ct_kwargs.items():
            if v.lower() in ("true", "false"):
                lines.append(f"            {k}: {v.lower()}")
            else:
                try:
                    lines.append(f"            {k}: {float(v) if '.' in v else int(v)}")
                except ValueError:
                    lines.append(f"            {k}: {v}")
    return lines


def _cpi_agent_block(args: argparse.Namespace) -> list[str]:
    """cpi (pi + cpi harness) agent block via import_path."""
    lines: list[str] = [
        "  - import_path: harbor_agents.cpi_pi:CpiPi",
        f"    model_name: {args.provider}/{args.model}",
        "    kwargs:",
    ]
    model_config_path = getattr(args, "model_config_path", None)
    if args.builtin:
        lines.extend([
            f"      provider: {args.provider}",
            f'      api_key: "{args.api_key}"',
            "      builtin: true",
        ])
    elif model_config_path:
        lines.append(f"      model_config: {json.dumps(model_config_path)}")
    else:
        lines.extend([
            f"      api_base: {args.endpoint}",
            f'      api_key: "{args.api_key}"',
            f"      provider: {args.provider}",
            f"      context_window: {args.max_input_tokens}",
            f"      max_output_tokens: {args.max_output_tokens}",
            f"      reasoning: {str(args.reasoning).lower()}",
        ])
    if args.thinking:
        lines.append(f"      thinking: {args.thinking}")
    if args.cpi_ref:
        lines.append(f"      cpi_ref: {args.cpi_ref}")
    if args.cpi_repo:
        lines.append(f"      cpi_repo: {args.cpi_repo}")
    lines.extend([
        "    env:",
        f'      OPENAI_API_KEY: "{args.api_key}"',
    ])
    return lines


def _dataset_block(args: argparse.Namespace) -> list[str]:
    """Build the datasets block."""
    lines: list[str] = ["datasets:"]
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
    return lines


def default_job_name(model: str | None) -> str:
    safe = (model or "model").replace("/", "-").replace(":", "-")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"tb21-{safe}-{stamp}"


def _resolve_model_config(value: str, jobs_dir: Path, job_name: str) -> str:
    """Resolve --model-config to an absolute path to a JSON file.

    Accepts a path to an existing file, or inline JSON (written to jobs_dir).
    """
    v = value.strip()
    if v.startswith("{"):
        try:
            data = json.loads(v)
        except json.JSONDecodeError as e:
            raise SystemExit(f"error: --model-config inline JSON parse error: {e}")
        out = jobs_dir / f"{job_name}.models.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(data, indent=2))
        return str(out.resolve())
    p = Path(value).expanduser().resolve()
    if not p.is_file():
        raise SystemExit(f"error: --model-config file not found: {value}")
    return str(p)


def _config_first_provider_model(cfg: dict) -> tuple[str, str]:
    """Return (provider, model_id) of the first provider/model in a models.json dict."""
    providers = cfg["providers"]
    provider = next(iter(providers))
    model_list = providers[provider].get("models") or []
    if not model_list:
        raise SystemExit(f"error: provider '{provider}' has no models in --model-config")
    return provider, model_list[0]["id"]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run TerminalBench 2.1 via Harbor against an OpenAI-compatible endpoint.",
    )
    p.add_argument("--endpoint", required=False, default=None,
                   help="OpenAI-compatible base URL. Required unless --model-config is given (--agent cpi).")
    p.add_argument("--api-key", default=os.environ.get("OPENAI_API_KEY", "NO"),
                   help="API key. Defaults to OPENAI_API_KEY env var or 'NO'.")
    p.add_argument("--model", required=False, default=None,
                   help="Model name served by the endpoint (e.g. moonshotai/Kimi-K2.7-Code). Required unless --model-config is given (--agent cpi).")
    p.add_argument("--dataset", default=None,
                   help="Harbor Hub dataset name (e.g. terminal-bench/terminal-bench-2-1). "
                        "If omitted, uses local clone.")
    p.add_argument("--tasks-path", default=DEFAULT_TASKS_PATH,
                   help=f"Path to local TB2.1 tasks. Default: {DEFAULT_TASKS_PATH}")
    p.add_argument("--agent", default=DEFAULT_AGENT,
                   help=f"Harbor agent. Default: {DEFAULT_AGENT}. Use 'cpi' for pi+cpi harness.")
    p.add_argument("--job-name", default=None)
    p.add_argument("--jobs-dir", default=DEFAULT_JOBS_DIR,
                   help=f"Directory for job outputs. Default: {DEFAULT_JOBS_DIR}")
    p.add_argument("--n-concurrent", type=int, default=DEFAULT_N_CONCURRENT,
                   help=f"Concurrent trials. Default: {DEFAULT_N_CONCURRENT}")
    p.add_argument("--n-attempts", type=int, default=1,
                   help="Attempts per task. Default: 1")
    p.add_argument("--max-tasks", type=int, default=None,
                   help="Limit number of tasks.")
    p.add_argument("--task-name", action="append",
                   help="Include task name/pattern (repeatable).")
    p.add_argument("--exclude-task-name", action="append",
                   help="Exclude task name/pattern (repeatable).")
    p.add_argument("--temperature", type=float, default=1.0,
                   help="Sampling temperature. Default: 1.0")
    p.add_argument("--top-p", type=float, default=0.95,
                   help="Top-p sampling. Default: 0.95")
    p.add_argument("--max-input-tokens", type=int, default=262144,
                   help="Model context window. Default: 262144")
    p.add_argument("--max-output-tokens", type=int, default=32768,
                   help="Max output tokens. Default: 32768")
    p.add_argument("--reasoning-effort", default=None,
                   help="Reasoning effort level (terminus-2 only, e.g. 'max' for GLM-5.2)")
    p.add_argument("--interleaved-thinking", action="store_true",
                   help="Enable interleaved thinking (terminus-2 only). "
                        "Recommended for reasoning models like Kimi K2.7 and GLM-5.2.")
    p.add_argument("--chat-template-kwargs", default=None,
                   help="Comma-separated key=value pairs for SGLang chat_template_kwargs "
                        "(terminus-2 only, e.g. 'reasoning_effort=max')")
    # cpi-agent options
    p.add_argument("--provider", default=DEFAULT_PROVIDER,
                   help=f"pi provider name for --agent cpi (models.json key). Default: {DEFAULT_PROVIDER}")
    p.add_argument("--thinking", default=None,
                   choices=["off", "minimal", "low", "medium", "high", "xhigh"],
                   help="pi --thinking level for --agent cpi.")
    p.add_argument("--reasoning", action=argparse.BooleanOptionalAction, default=True,
                   help="Mark model as reasoning-capable in pi models.json (--agent cpi). "
                        "Default: --reasoning; use --no-reasoning to disable.")
    p.add_argument("--cpi-ref", default=None,
                   help="git ref (branch/tag/commit) to clone cpi at. Default: default branch.")
    p.add_argument("--cpi-repo", default=DEFAULT_CPI_REPO,
                   help=f"cpi git repo URL. Default: {DEFAULT_CPI_REPO}")
    p.add_argument("--model-config", default=None,
                   help="Path to a JSON file (or inline JSON) with the FULL pi models.json "
                        "(providers/models, incl. compat, cost). --agent cpi only. "
                        "When given, overrides --endpoint/--model/--api-key/--provider/"
                        "--max-input-tokens/--max-output-tokens/--reasoning for the cpi models.json.")
    p.add_argument("--builtin", action="store_true",
                   help="Use a pi built-in provider (e.g. deepseek) without clobbering its models.json. "
                        "Writes the API key to auth.json; models.json stays supplementary. --agent cpi only.")
    p.add_argument("--force-clone", action="store_true",
                   help="Re-clone TB2.1 repo even if it exists.")
    p.add_argument("--dry-run", action="store_true",
                   help="Write config and print command without running.")
    args = p.parse_args()
    return args


def main() -> int:
    args = parse_args()
    project_dir = Path(__file__).parent.resolve()
    jobs_dir = project_dir / args.jobs_dir
    args.model_config_path = None
    if args.agent == "cpi" and args.model_config:
        args.model_config_path = _resolve_model_config(
            args.model_config, jobs_dir, args.job_name
        )
        cfg = json.loads(Path(args.model_config_path).read_text())
        provider, model_id = _config_first_provider_model(cfg)
        args.provider = provider
        args.model = model_id
        args.endpoint = cfg["providers"][provider].get("baseUrl", "")
        args.api_key = cfg["providers"][provider].get("apiKey", "NO")
    if args.builtin and args.model_config:
        raise SystemExit("error: --builtin and --model-config are mutually exclusive")
    if args.builtin:
        if args.agent != "cpi":
            raise SystemExit("error: --builtin requires --agent cpi")
        if not args.model:
            raise SystemExit("error: --model required for --builtin (e.g. deepseek-v4-pro)")
        if args.provider == DEFAULT_PROVIDER:
            raise SystemExit("error: --builtin requires --provider (a pi built-in, e.g. deepseek)")
    if not args.model_config_path and not args.builtin and (not args.endpoint or not args.model):
        raise SystemExit(
            "error: --endpoint and --model are required "
            "(or pass --model-config / --builtin for --agent cpi)"
        )
    if args.job_name is None:
        args.job_name = default_job_name(args.model)
    if not args.dry_run:
        ensure_tb21(Path(args.tasks_path), args.force_clone)
    config_text = build_config(args, project_dir)
    config_path = jobs_dir / f"{args.job_name}.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(config_text)
    print(f"Wrote Harbor job config: {config_path}")
    print("---")
    print(config_text)
    print("---")
    env = os.environ.copy()
    env["OPENAI_API_KEY"] = args.api_key
    if args.agent == "cpi":
        # harbor_agents package lives under benchmarks/; make it importable.
        env["PYTHONPATH"] = (
            str(project_dir.parent) + os.pathsep + env.get("PYTHONPATH", "")
        )
    harbor_bin = str(project_dir.parent / ".venv" / "bin" / "harbor")
    cmd = [
        harbor_bin, "run", "--config", str(config_path),
    ]
    if args.dry_run:
        print("Dry run. To execute:")
        print(" ".join(cmd))
        return 0
    run(cmd, env=env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
