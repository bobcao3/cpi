import math

from .cache import ReferenceCache
from .config import cache_directory, fingerprint
from .inputs import normalize_document
from .metrics import numeric_deltas
from .progress import progress


class Analyzer:
    def __init__(self, settings):
        self.settings = settings
        self.engine = None
        self.cache = ReferenceCache(cache_directory(), fingerprint(settings))

    def analyze(self, document, detail=True):
        if self.engine is None:
            progress("Initializing NLP components...")
            from .engine import Engine

            self.engine = Engine(self.settings)
        return self.engine.analyze(document, detail)

    def request(self, method, params):
        if method == "cache/stats":
            return self.cache.stats()
        if method == "cache/clear":
            return self.cache.clear()
        if method != "analyze":
            raise ValueError(f"Unknown analysis method: {method}")
        if "document" not in params:
            raise ValueError("analyze requires a document")
        if "reference" in params and "reference_id" in params:
            raise ValueError("Provide reference or reference_id, not both")
        document = normalize_document(params["document"])
        reference = None
        reference_id = params.get("reference_id")
        cache_hit = False
        if "reference" in params:
            reference_document = normalize_document(params["reference"])
            reference_id = self.cache.key(reference_document)
            reference = self.cache.get(reference_id)
            cache_hit = reference is not None
            if reference is None:
                progress("Analyzing and caching the reference corpus...")
                reference = self.analyze(reference_document, detail=False)
                self.cache.put(reference_id, reference)
            else:
                progress("Using cached reference analysis.")
        elif reference_id is not None:
            if not isinstance(reference_id, str):
                raise ValueError("reference_id must be a string")
            reference = self.cache.get(reference_id)
            if reference is None:
                raise ValueError("Reference is missing or outdated; provide its source again")
            cache_hit = True
            progress("Using cached reference analysis.")
        progress("Analyzing input...")
        analysis = self.analyze(document, detail=params.get("detail", True))
        result = {"analysis": analysis}
        if reference is not None:
            result["reference"] = {
                "id": reference_id,
                "cache_hit": cache_hit,
                "sources": reference.get("sources", []),
                "segments": reference.get("segment_count", len(reference.get("segments", []))),
                "statistics": reference["statistics"],
                "clauses": reference["clauses"],
                "tone": reference["tone"],
                "style": reference["style"],
                "provenance": reference["provenance"],
            }
            result["comparison"] = {
                "statistics": numeric_deltas(analysis["statistics"], reference["statistics"]),
                "tone": numeric_deltas(
                    analysis["tone"].get("scores", {}), reference["tone"].get("scores", {})
                ),
                "style_cosine_similarity": style_similarity(analysis["style"], reference["style"]),
            }
        return result


def style_similarity(current, reference):
    left, right = current.get("embedding"), reference.get("embedding")
    if left is None or right is None:
        return None
    if (current["model"], current["revision"]) != (reference["model"], reference["revision"]):
        raise ValueError("Style embeddings use different checkpoints")
    if len(left) != len(right) or not left:
        raise ValueError("Style embeddings have incompatible dimensions")
    numerator = sum(a * b for a, b in zip(left, right, strict=True))
    denominator = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
    if not math.isfinite(numerator) or not denominator > 0:
        raise ValueError("Style embeddings are non-finite or zero")
    return max(-1.0, min(1.0, numerator / denominator))
