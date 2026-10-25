import hashlib
import importlib.metadata
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Settings:
    spacy_model: str = "en_core_web_sm"
    tone_model: str | None = "deberta"
    style_model: str | None = "styledistance"
    device: str = "auto"
    offline: bool = False
    compile: bool = True
    tone_labels: tuple[str, ...] = (
        "formal",
        "informal",
        "friendly",
        "assertive",
        "tentative",
        "sarcastic",
    )
    idle_seconds: int = 900

    def __post_init__(self):
        if self.device not in {"auto", "cpu", "cuda", "mps"}:
            raise ValueError("device must be auto, cpu, cuda, or mps")
        if not 1 <= self.idle_seconds <= 86_400:
            raise ValueError("idle_seconds must be between 1 and 86400")
        if not self.spacy_model:
            raise ValueError("spacy_model must not be empty")
        if (
            not 2 <= len(self.tone_labels) <= 32
            or any(
                not isinstance(label, str) or not label.strip() or len(label) > 80
                for label in self.tone_labels
            )
            or len(set(self.tone_labels)) != len(self.tone_labels)
        ):
            raise ValueError(
                "tone_labels must contain 2 to 32 distinct nonempty labels of at most 80 characters"
            )

    @classmethod
    def from_env(cls):
        values: dict[str, Any] = {}
        for name in cls.__dataclass_fields__:
            value = os.environ.get(f"CPI_PROSE_{name.upper()}")
            if value is not None:
                if name == "idle_seconds":
                    values[name] = int(value)
                elif name == "tone_labels":
                    labels = json.loads(value)
                    if not isinstance(labels, list):
                        raise ValueError("CPI_PROSE_TONE_LABELS must be a JSON array")
                    values[name] = tuple(labels)
                elif name in {"offline", "compile"}:
                    if value.lower() not in {"0", "1", "true", "false"}:
                        raise ValueError(f"CPI_PROSE_{name.upper()} must be true, false, 1, or 0")
                    values[name] = value.lower() in {"1", "true"}
                else:
                    values[name] = value or None
        return cls(**values)

    def to_dict(self):
        return asdict(self)


def fingerprint(settings: Settings) -> str:
    digest = hashlib.sha256()
    root = Path(__file__).resolve().parents[2]
    source_root = Path(__file__).parent
    sources = sorted(source_root.rglob("*.py")) + sorted(
        (source_root.parent / "textdescriptives").rglob("*.py")
    )
    for path in sources + [root / "pyproject.toml", root / "uv.lock", root / ".python-version"]:
        digest.update(str(path.relative_to(root)).encode())
        if path.exists():
            digest.update(path.read_bytes())
    digest.update(sys.version.encode())
    digest.update(str(Path(sys.prefix).resolve()).encode())
    for name in (
        "cpi-prose",
        "spacy",
        "numpy",
        "pyphen",
        "spacy-lookups-data",
        "preshed",
        "torch",
        "transformers",
        "sentence-transformers",
        "huggingface-hub",
        settings.spacy_model,
    ):
        try:
            digest.update(f"{name}={importlib.metadata.version(name)}".encode())
        except importlib.metadata.PackageNotFoundError:
            digest.update(f"{name}=absent".encode())
    digest.update(json.dumps(settings.to_dict(), sort_keys=True).encode())
    execution = {
        name: os.environ.get(name)
        for name in ("TORCHINDUCTOR_FREEZING", "OMP_NUM_THREADS", "MKL_NUM_THREADS")
    }
    digest.update(json.dumps(execution, sort_keys=True).encode())
    if settings.device in {"auto", "cuda"}:
        visibility = {
            name: os.environ.get(name)
            for name in ("CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER", "NVIDIA_VISIBLE_DEVICES")
        }
        digest.update(json.dumps(visibility, sort_keys=True).encode())
    return digest.hexdigest()


def cache_directory() -> Path:
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    path = base / "cpi-prose"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise ValueError("cache directory must be owned by the current user")
    path.chmod(0o700)
    return path
