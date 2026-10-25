from .config import Settings
from .progress import progress

CHECKPOINTS = {
    "deberta": (
        "MoritzLaurer/deberta-v3-base-zeroshot-v2.0-c",
        "bddf8c5411c34ac3565e16e04384fd68b2618dda",
    ),
    "styledistance": (
        "StyleDistance/styledistance",
        "b7df5f0b0480773c097ba3121d83ca32b71015ca",
    ),
}
HYPOTHESIS = "The tone of this text is {}."
BATCH_SIZE = 16


def checkpoint(specification: str) -> tuple[str, str]:
    if specification in CHECKPOINTS:
        return CHECKPOINTS[specification]
    name, separator, revision = specification.rpartition("@")
    if (
        not separator
        or not name
        or len(revision) != 40
        or any(character not in "abcdef0123456789" for character in revision)
    ):
        raise ValueError("model must be a built-in alias or a Hugging Face ID@40-character-commit")
    return name, revision


def chunks(texts, tokenizer, budget):
    result, weights = [], []
    if not tokenizer.is_fast:
        raise ValueError("encoder requires a fast tokenizer with offset mappings")
    for index, text in enumerate(texts, 1):
        encoded = tokenizer(
            text, add_special_tokens=False, return_offsets_mapping=True, verbose=False
        )
        offsets = encoded["offset_mapping"]
        for start in range(0, len(offsets), budget):
            section = offsets[start : start + budget]
            if section:
                result.append(text[section[0][0] : section[-1][1]])
                weights.append(len(section))
        if index % 1000 == 0:
            progress(f"Chunked {index} blocks into {len(result)} sections...")
    return result, weights


class NeuralModels:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.tone = None
        self.style = None
        self.style_warmed = False
        self.device = None

    def select_device(self):
        if self.device is not None:
            return self.device
        try:
            import torch
        except ImportError as error:
            raise RuntimeError(
                "Install an inference extra with uv sync --extra cpu, cuda, or apple"
            ) from error
        requested = self.settings.device
        if requested == "auto":
            requested = (
                "cuda"
                if torch.cuda.is_available()
                else ("mps" if torch.backends.mps.is_available() else "cpu")
            )
        if requested == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA was requested but is unavailable")
        if requested == "cuda" and not torch.cuda.is_bf16_supported(including_emulation=False):
            raise ValueError("The selected CUDA device does not support native BF16")
        if requested == "mps" and not torch.backends.mps.is_available():
            raise ValueError("Apple MPS was requested but is unavailable")
        self.device = requested
        hardware = torch.cuda.get_device_name() if requested == "cuda" else requested
        progress(f"Inference device: {hardware} ({requested}), BF16.")
        return requested

    def tone_scores(self, texts):
        session = self.tone_session()
        session.add(texts)
        return session.finish()

    def tone_session(self):
        return ToneSession(self)

    def style_embedding(self, texts):
        session = self.style_session()
        session.add(texts)
        return session.finish()

    def style_session(self):
        return StyleSession(self)


class ToneSession:
    def __init__(self, models):
        self.models = models
        self.scorer = None
        self.name = None
        self.revision = None
        self.labels = list(models.settings.tone_labels)
        self.totals = dict.fromkeys(self.labels, 0.0)
        self.weight = 0
        self.chunks = 0
        self.timing = {
            "inference_seconds": 0.0,
            "warmup_included": False,
            "pairs": 0,
            "batch_size": BATCH_SIZE,
            "batch_shapes": [],
            "input_tokens": 0,
            "padded_tokens": 0,
        }

    def load(self):
        if self.scorer is not None:
            return
        self.name, self.revision = checkpoint(self.models.settings.tone_model)
        if self.models.tone is None:
            from .nli import NliScorer

            self.models.tone = NliScorer(
                self.name,
                self.revision,
                self.models.select_device(),
                self.models.settings.offline,
                self.models.settings.compile,
            )
        self.scorer = self.models.tone

    def add(self, texts):
        if self.models.settings.tone_model is None:
            return
        if not any(text.strip() for text in texts):
            return
        self.load()
        assert self.scorer is not None
        sections, weights = chunks(texts, self.scorer.tokenizer, 384)
        if not sections:
            return
        totals, timing = self.scorer.score(sections, weights, self.labels, HYPOTHESIS)
        batch_weight = sum(weights)
        for label in self.labels:
            self.totals[label] += totals[label] * batch_weight
        self.weight += batch_weight
        self.chunks += len(sections)
        for name in ("inference_seconds", "pairs", "input_tokens", "padded_tokens"):
            self.timing[name] += timing[name]
        self.timing["warmup_included"] = self.timing["warmup_included"] or timing["warmup_included"]
        self.timing["batch_size"] = timing["batch_size"]
        self.timing["batch_shapes"] = timing["batch_shapes"]

    def finish(self):
        if self.models.settings.tone_model is None:
            return {"status": "disabled"}
        if not self.chunks:
            return {"status": "empty"}
        assert self.scorer is not None and self.weight > 0
        return {
            "status": "enabled",
            "model": self.name,
            "revision": self.revision,
            "device": self.models.select_device(),
            "method": "zero-shot-nli",
            "dtype": "bfloat16",
            "attention": self.scorer.attention,
            "transformers_attention_backend": self.scorer.attention_backend,
            "execution": self.scorer.execution,
            "model_bytes": self.scorer.model_bytes,
            "timing": self.timing,
            "hypothesis": HYPOTHESIS,
            "multi_label": True,
            "chunks": self.chunks,
            "scores": {label: self.totals[label] / self.weight for label in self.labels},
        }


class StyleSession:
    def __init__(self, models):
        self.models = models
        self.encoder = None
        self.name = None
        self.revision = None
        self.budget = None
        self.pooled = None
        self.weight = 0
        self.chunks = 0

    def load(self):
        if self.encoder is not None:
            return
        import torch
        from sentence_transformers import SentenceTransformer

        self.name, self.revision = checkpoint(self.models.settings.style_model)
        if self.models.style is None:
            progress(
                f"Loading style encoder {self.name} in BF16/SDPA; uncached files download now..."
            )
            self.models.style = SentenceTransformer(
                self.name,
                revision=self.revision,
                device=self.models.select_device(),
                local_files_only=self.models.settings.offline,
                trust_remote_code=False,
                model_kwargs={"dtype": torch.bfloat16, "attn_implementation": "sdpa"},
            )
            self.models.style.eval()
            if any(
                parameter.dtype != torch.bfloat16 for parameter in self.models.style.parameters()
            ):
                raise RuntimeError("Style encoder did not load entirely in BF16")
            if self.models.settings.compile:
                self.models.style.compile(dynamic=True)
        self.encoder = self.models.style
        maximum = min(self.encoder.max_seq_length or 512, 512)
        self.budget = maximum - self.encoder.tokenizer.num_special_tokens_to_add()
        if self.budget < 1:
            raise ValueError("style encoder has no usable context window")

    def add(self, texts):
        if self.models.settings.style_model is None:
            return
        if not any(text.strip() for text in texts):
            return
        import numpy as np
        import torch

        self.load()
        assert self.encoder is not None and self.budget is not None
        if self.models.settings.compile and not self.models.style_warmed:
            progress("Compiling/warming BF16 style-encoder graphs; attention=SDPA...")
        sections, weights = chunks(texts, self.encoder.tokenizer, self.budget)
        if not sections:
            return
        for start in range(0, len(sections), BATCH_SIZE * 16):
            end = start + BATCH_SIZE * 16
            batch_sections = sections[start:end]
            batch_weights = weights[start:end]
            vectors = self.encoder.encode(
                batch_sections,
                batch_size=BATCH_SIZE,
                normalize_embeddings=True,
                convert_to_tensor=True,
                show_progress_bar=False,
            )
            vectors = vectors.to(device="cpu", dtype=torch.float64).numpy()
            if self.pooled is None:
                self.pooled = np.zeros(vectors.shape[1], dtype=np.float64)
            self.pooled += np.average(vectors, axis=0, weights=batch_weights) * sum(batch_weights)
            self.weight += sum(batch_weights)
            self.chunks += len(batch_sections)
            if start % (BATCH_SIZE * 128) == 0:
                progress(f"Style encoder BF16/SDPA: {self.chunks} chunks...")
        self.models.style_warmed = True

    def finish(self):
        if self.models.settings.style_model is None:
            return {"status": "disabled"}
        if not self.chunks:
            return {"status": "empty"}
        import numpy as np

        assert self.pooled is not None and self.weight > 0
        pooled = self.pooled / self.weight
        norm = np.linalg.norm(pooled)
        if not np.isfinite(pooled).all() or not norm > 0:
            raise RuntimeError("style encoder returned a non-finite or zero vector")
        progress("Style encoding complete.")
        return {
            "status": "enabled",
            "model": self.name,
            "revision": self.revision,
            "device": self.models.select_device(),
            "chunks": self.chunks,
            "embedding": (pooled / norm).tolist(),
            "dtype": "bfloat16",
            "attention": "sdpa",
            "execution": "torch.compile" if self.models.settings.compile else "native",
            "pooling": "token-weighted mean of normalized chunk vectors, then L2 normalization",
        }
