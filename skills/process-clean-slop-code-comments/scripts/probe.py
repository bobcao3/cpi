#!/usr/bin/env python3
"""Extract, strip, or restore a Python docstring or comment block.

Docstring targets resolve via ast (module by default, or a function/class by
dotted name). Comment targets resolve via line anchoring: `--target
comment:<text>` picks the first full-line comment containing <text> plus the
contiguous full-line comment run it belongs to.

Commands:
  show FILE [--target T]    print the block with line numbers
  strip FILE [--target T]   remove the block; backup at FILE.probe-bak
  restore FILE              copy the backup back, verify, remove it

`strip` refuses to run while a backup exists; `restore` warns if the live
file drifted from the backup before overwriting it.
"""

from __future__ import annotations

import argparse
import ast
import difflib
import os
import shutil
import sys
import tempfile
from pathlib import Path

BAK_SUFFIX = ".probe-bak"
DEF_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def _docstring_span(source: str, target: str) -> tuple[int, int]:
    node: ast.AST | None = ast.parse(source)
    parts = [] if target in ("module", "") else target.split(".")
    for part in parts:
        if node is None:
            sys.exit(f"comment-probe: target not found: {target}")
        node = next(
            (
                child
                for child in ast.iter_child_nodes(node)
                if isinstance(child, DEF_NODES) and child.name == part
            ),
            None,
        )
    if node is None:
        sys.exit(f"comment-probe: target not found: {target}")
    assert isinstance(node, (ast.Module, *DEF_NODES))
    first = node.body[0]
    if not (
        isinstance(first, ast.Expr)
        and isinstance(first.value, ast.Constant)
        and isinstance(first.value.value, str)
    ):
        sys.exit(f"comment-probe: no docstring on target: {target or 'module'}")
    start, end = first.lineno, first.end_lineno
    assert isinstance(start, int) and isinstance(end, int)
    return start, end


def _comment_span(source: str, anchor: str) -> tuple[int, int]:
    lines = source.splitlines()
    hits = [
        i
        for i, line in enumerate(lines)
        if line.lstrip().startswith("#") and anchor in line
    ]
    if not hits:
        sys.exit(f"comment-probe: no full-line comment containing {anchor!r}")
    start = hits[0]
    end = start
    while end + 1 < len(lines) and (
        lines[end + 1].lstrip().startswith("#") or not lines[end + 1].strip()
    ):
        end += 1
    while end > start and not lines[end].strip():
        end -= 1
    return start + 1, end + 1


def _span(source: str, target: str) -> tuple[int, int]:
    if target.startswith("comment:"):
        return _comment_span(source, target[len("comment:") :])
    return _docstring_span(source, target)


def _write_atomic(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def cmd_show(path: Path, target: str) -> None:
    lines = path.read_text().splitlines()
    start, end = _span("\n".join(lines), target)
    for n in range(start, end + 1):
        print(f"{n:>5} {lines[n - 1]}")


def cmd_strip(path: Path, target: str) -> None:
    backup = path.with_name(path.name + BAK_SUFFIX)
    if backup.exists():
        sys.exit(f"comment-probe: backup already exists, restore first: {backup}")
    lines = path.read_text().splitlines()
    start, end = _span("\n".join(lines), target)
    shutil.copy2(path, backup)
    kept = lines[: start - 1] + lines[end:]
    if 0 < start - 1 < len(kept) and not kept[start - 2].strip() and not kept[start - 1].strip():
        del kept[start - 1]
    _write_atomic(path, "\n".join(kept) + "\n")
    print(f"STRIPPED {path}:{start}-{end} backup={backup}")


def cmd_restore(path: Path) -> None:
    backup = path.with_name(path.name + BAK_SUFFIX)
    if not backup.exists():
        sys.exit(f"comment-probe: no backup: {backup}")
    original = backup.read_text()
    if path.read_text() != original:
        diff = difflib.unified_diff(
            original.splitlines(), path.read_text().splitlines(), "backup", "live", lineterm=""
        )
        sys.stderr.write("\n".join(diff) + "\ncomment-probe: live file drifted; restoring\n")
    _write_atomic(path, original)
    backup.unlink()
    print("RESTORED " + str(path))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("show", "strip"):
        p = sub.add_parser(name)
        p.add_argument("file", type=Path)
        p.add_argument("--target", default="module")
    p = sub.add_parser("restore")
    p.add_argument("file", type=Path)
    args = parser.parse_args()

    if not args.file.exists():
        sys.exit(f"comment-probe: no such file: {args.file}")
    if args.cmd == "show":
        cmd_show(args.file, args.target)
    elif args.cmd == "strip":
        cmd_strip(args.file, args.target)
    else:
        cmd_restore(args.file)


if __name__ == "__main__":
    main()
