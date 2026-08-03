#!/usr/bin/env python3
"""Debate-review-rebuttle phase runner. Template — copy into the run workspace,
then execute one JSON manifest per phase:

    python3 run_phase.py manifest.json results/

Manifest format:

    {
      "template": "Review the paper, focusing on {{FOCUS}}. ...",
      "entries": [{"id": "rev01", "vars": {"FOCUS": "methodology"}}, ...]
    }

Each entry's prompt is rendered from "template" by substituting {{KEY}} with
the entry's "vars"; any unresolved placeholder is a hard error. An entry may
instead carry a literal "prompt" key, which overrides templating.

Each entry launches `subagent -p PROVIDER -m MODEL:EFFORT -s SESSION_PREFIX-<id>`
with the prompt on stdin. Final answers land in results/<id>.md; progress goes
to stderr. Re-running is idempotent: entries with an existing non-empty result
file are skipped.

The orchestrating agent writes manifests and merges results between phases
(review -> rebut -> adjudicate). This script only fans out and collects.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# Provider for subagent -p. Pin one (e.g. deepseek or openai-codex) via the
# DRR_PROVIDER env var, or leave empty to use pi's configured default provider.
PROVIDER = os.environ.get("DRR_PROVIDER", "")
MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731"
EFFORT = "max"
MAX_WORKERS = 16
SESSION_PREFIX = "drr"

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, file=sys.stderr, flush=True)


def run_one(entry: dict, results_dir: Path) -> str:
    out_path = results_dir / f"{entry['id']}.md"
    if out_path.exists() and out_path.stat().st_size > 0:
        log(f"skip {entry['id']} (cached)")
        return entry["id"]
    log(f"start {entry['id']}")
    session_id = re.sub(
        r"[^A-Za-z0-9._-]+", "_", f"{SESSION_PREFIX}-{entry['id']}"
    ).strip("_") or SESSION_PREFIX
    cmd = ["subagent"]
    if PROVIDER:
        cmd += ["-p", PROVIDER]
    cmd += ["-m", f"{MODEL}:{EFFORT}", "-s", session_id]
    proc = subprocess.run(
        cmd,
        input=entry["_rendered_prompt"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        log(f"FAIL {entry['id']} (exit {proc.returncode}): {proc.stdout[-500:]}")
        return entry["id"]
    out_path.write_text(proc.stdout)
    log(f"done {entry['id']}")
    return entry["id"]


def main() -> None:
    manifest = json.loads(Path(sys.argv[1]).read_text())
    if isinstance(manifest, dict):
        template = manifest.get("template")
        entries = manifest["entries"]
    else:  # backward compatibility: bare list of entries
        template = None
        entries = manifest
    results_dir = Path(sys.argv[2])
    results_dir.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        if "prompt" in entry:
            entry["_rendered_prompt"] = entry["prompt"]
        else:
            if template is None:
                sys.exit(f"entry {entry['id']}: no 'prompt' and no manifest 'template'")
            prompt = template
            for key, value in entry.get("vars", {}).items():
                prompt = prompt.replace("{{" + key + "}}", str(value))
            unresolved = re.findall(r"\{\{[^}]*\}\}", prompt)
            if unresolved:
                sys.exit(f"entry {entry['id']}: unresolved placeholders {unresolved}")
            entry["_rendered_prompt"] = prompt
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        ids = list(pool.map(lambda e: run_one(e, results_dir), entries))
    missing = [i for i in ids if not (results_dir / f"{i}.md").exists()]
    log(f"phase complete: {len(ids) - len(missing)}/{len(ids)} ok")
    if missing:
        log(f"missing: {missing}")
        sys.exit(1)


if __name__ == "__main__":
    main()
