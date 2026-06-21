#!/usr/bin/env python3
"""Pretty-print recent steps from a running TerminalBench 3.0 Harbor job."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path


def latest_job(jobs_dir: Path) -> Path:
    jobs = [d for d in jobs_dir.iterdir() if d.is_dir()]
    if not jobs:
        raise SystemExit(f"No jobs found in {jobs_dir}")
    return max(jobs, key=lambda p: p.stat().st_mtime)


def trajectory_file(job_dir: Path) -> Path:
    for traj in job_dir.rglob("trajectory.json"):
        return traj
    raise SystemExit(f"No trajectory.json found under {job_dir}")


def print_steps(trajectory: Path, n: int) -> None:
    data = json.loads(trajectory.read_text())
    steps = data if isinstance(data, list) else data.get("steps", [])
    for step in steps[-n:]:
        ts = str(step.get("timestamp", "?"))[:19]
        source = step.get("source", "?")
        msg = step.get("message", "")
        summary = msg.strip().split("\n")[0][:120]
        tools = step.get("tool_calls", [])
        tool_names = [t.get("function_name", "?") for t in tools]
        print(f"[{ts}] step {step.get('step_id', '?')} | {source}")
        print(f"  {summary}")
        if tool_names:
            print(f"  tools: {', '.join(tool_names)}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Monitor a TB3 Harbor job from its trajectory.",
    )
    parser.add_argument(
        "--jobs-dir",
        type=Path,
        default=Path("./jobs"),
        help="Directory containing Harbor job outputs. Default: ./jobs",
    )
    parser.add_argument(
        "--job",
        help="Job directory name (default: most recently modified)",
    )
    parser.add_argument(
        "-n",
        type=int,
        default=10,
        help="Number of recent steps to show. Default: 10",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Poll continuously.",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=10.0,
        help="Poll interval in seconds. Default: 10",
    )
    args = parser.parse_args()

    jobs_dir = args.jobs_dir.resolve()
    job_dir = jobs_dir / args.job if args.job else latest_job(jobs_dir)
    traj = trajectory_file(job_dir)
    print(f"Monitoring {job_dir.name} ({traj.relative_to(jobs_dir)})")

    while True:
        print_steps(traj, args.n)
        if not args.watch:
            break
        time.sleep(args.interval)
        print("\n" + "=" * 60 + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
