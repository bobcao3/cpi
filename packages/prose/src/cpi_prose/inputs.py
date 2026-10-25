import json
import os
import stat
from pathlib import Path
from typing import Any

KINDS = {"text", "comment", "docstring", "doc-comment", "comments"}
METADATA = (
    "scope",
    "source",
    "start_point",
    "end_point",
    "start_byte",
    "end_byte",
    "target",
    "span",
)


def checked_corpus(path: str) -> Path:
    corpus = Path(path)
    info = os.lstat(corpus)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        raise ValueError("corpus must be a regular 0600 file owned by the current user")
    return corpus


def normalize_segment(segment: Any, index: int) -> dict:
    if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
        raise ValueError(f"segment {index} needs a text string")
    text = segment["text"]
    kind = segment.get("kind", "text")
    if kind not in KINDS:
        raise ValueError(f"unsupported segment kind: {kind}")
    item = {"text": text, "kind": kind}
    for name in METADATA:
        if name in segment:
            item[name] = segment[name]
    return item


def segments(document: dict):
    if "corpus" in document:
        path = checked_corpus(document["corpus"])
        with path.open("r", encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"corpus line {number} is not valid JSON") from error
                yield normalize_segment(value, number)
        return
    for index, segment in enumerate(document["segments"]):
        yield normalize_segment(segment, index)


def identity(document: dict) -> str:
    if "corpus" in document:
        return (
            document["sha256"]
            + "\0"
            + json.dumps(document.get("sources", []), sort_keys=True, ensure_ascii=False)
        )
    return json.dumps(
        {"segments": document["segments"], "sources": document.get("sources", [])},
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
    )


def normalize_document(value: Any) -> dict:
    if isinstance(value, str):
        value = {"text": value}
    if not isinstance(value, dict):
        raise ValueError("document must be text or an object")
    if "corpus" in value:
        if not isinstance(value["corpus"], str):
            raise ValueError("corpus must be a file path")
        checked_corpus(value["corpus"])
        sha256 = value.get("sha256")
        if not isinstance(sha256, str) or len(sha256) != 64:
            raise ValueError("corpus needs a hexadecimal sha256 digest")
        sources = value.get("sources", [])
        if not isinstance(sources, list):
            raise ValueError("sources must be a list")
        count = value.get("segment_count", 0)
        if type(count) is not int or count < 0:
            raise ValueError("segment_count must be a nonnegative integer")
        return {
            "corpus": value["corpus"],
            "sources": sources,
            "segment_count": count,
            "sha256": sha256,
        }
    if "blocks" in value:
        result = probe_segments(value)
    elif "segments" in value:
        if not isinstance(value["segments"], list):
            raise ValueError("segments must be a list")
        result = [
            normalize_segment(segment, index) for index, segment in enumerate(value["segments"])
        ]
    elif isinstance(value.get("text"), str):
        result = [{"text": value["text"], "kind": "text"}]
    else:
        raise ValueError("document needs text, segments, corpus, or source_text with blocks")
    sources = value.get("sources", [])
    if not isinstance(sources, list):
        raise ValueError("sources must be a list")
    for segment in result:
        if "source" not in segment and "source" in value:
            segment["source"] = value["source"]
    return {"segments": result, "sources": sources, "segment_count": len(result)}


def probe_segments(value: dict) -> list[dict]:
    source = value.get("source_text")
    blocks = value["blocks"]
    if not isinstance(source, str) or not isinstance(blocks, list):
        raise ValueError("probe input needs source_text and a blocks list, not previews")
    lines = source.splitlines(keepends=True)
    result = []
    for block in blocks:
        if not isinstance(block, dict) or not isinstance(block.get("span"), dict):
            raise ValueError("probe block needs a span object")
        start, end = block["span"].get("start"), block["span"].get("end")
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(lines):
            raise ValueError("probe spans must be valid one-based inclusive line ranges")
        result.append(
            {
                **{key: block[key] for key in METADATA if key in block},
                "text": "".join(lines[start - 1 : end]),
                "kind": block.get("kind", "comment"),
                "scope": block.get("scope", {"target": block.get("target")}),
            }
        )
    return result
