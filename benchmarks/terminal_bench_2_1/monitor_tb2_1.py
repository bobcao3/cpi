#!/usr/bin/env python3
"""Monitor a running TerminalBench 2.1 Harbor job.

Usage:
  python monitor_tb2_1.py <job_dir>

Displays completion stats, rewards, and errors from result.json.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path


def load_result(job_dir: Path) -> dict:
    result_path = job_dir / "result.json"
    if not result_path.exists():
        return {}
    return json.loads(result_path.read_text())


def print_status(job_dir: Path, watch: bool = False) -> None:
    while True:
        result = load_result(job_dir)
        if not result:
            print(f"Waiting for result.json in {job_dir}...")
        else:
            s = result.get("stats", {})
            print(f"\n{'='*60}")
            print(f"Job: {job_dir.name}")
            print(f"Updated: {result.get('updated_at', '?')}")
            print(f"completed={s.get('n_completed_trials', 0)} "
                  f"errored={s.get('n_errored_trials', 0)} "
                  f"running={s.get('n_running_trials', 0)} "
                  f"pending={s.get('n_pending_trials', 0)} "
                  f"retries={s.get('n_retries', 0)}")
            for k, v in result.get("stats", {}).get("evals", {}).items():
                if v.get("metrics"):
                    print(f"  metrics: {v['metrics']}")
                if v.get("reward_stats"):
                    print(f"  rewards: {v['reward_stats']}")
                if v.get("exception_stats"):
                    for exc, tasks in v["exception_stats"].items():
                        if tasks:
                            print(f"  {exc}: {tasks}")
            # Show running tasks
            running: list[str] = []
            for d in sorted(job_dir.iterdir()):
                if not d.is_dir():
                    continue
                traj = d / "agent" / "trajectory.json"
                if traj.exists():
                    data = json.loads(traj.read_text())
                    steps = data.get("steps", data) if isinstance(data, dict) else data
                    n = len(steps) if isinstance(steps, list) else 0
                    # Check if has result.json (completed)
                    if not (d / "result.json").exists():
                        running.append(f"  {d.name}: {n} steps")
            if running:
                print(f"Running tasks ({len(running)}):")
                for line in running:
                    print(line)

        if not watch:
            return
        time.sleep(30)


def main() -> int:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <job_dir> [--watch]", file=sys.stderr)
        return 1
    job_dir = Path(sys.argv[1]).resolve()
    if not job_dir.is_dir():
        print(f"error: {job_dir} is not a directory", file=sys.stderr)
        return 1
    watch = "--watch" in sys.argv
    print_status(job_dir, watch=watch)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
