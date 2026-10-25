import importlib.metadata
import time
import warnings

import textdescriptives

from .clauses import METHOD, PROVENANCE, clause_count, clause_statistics
from .config import Settings
from .corpus import CorpusStatistics
from .distributions import PROVENANCE as DISTRIBUTION_PROVENANCE
from .distributions import distribution_statistics
from .inputs import segments
from .metrics import json_safe, sentence_record
from .models import NeuralModels
from .progress import progress

COMPONENTS = (
    "descriptive_stats",
    "readability",
    "dependency_distance",
    "pos_proportions",
    "information_theory",
)
TEXTDESCRIPTIVES_PAPER = "https://doi.org/10.21105/joss.05153"
BATCH_CHARS = 200_000


class Engine:
    def __init__(self, settings: Settings):
        import spacy

        self.settings = settings
        progress(f"Loading spaCy pipeline {settings.spacy_model}...")
        try:
            self.nlp = spacy.load(settings.spacy_model, exclude=["ner"])
        except OSError as error:
            raise RuntimeError(
                "The configured spaCy pipeline is missing. Run uv sync --extra cpu "
                "or set CPI_PROSE_SPACY_MODEL to an installed pipeline."
            ) from error
        if "parser" not in self.nlp.pipe_names:
            raise ValueError("The spaCy pipeline must include a trained dependency parser")
        self.nlp.max_length = 2**31 - 1
        for name in COMPONENTS:
            self.nlp.add_pipe(f"textdescriptives/{name}")
        self.models = NeuralModels(settings)
        progress("spaCy and TextDescriptives are ready.")

    def statistics(self, doc, sentences):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            statistics = (
                {name: getattr(doc._, name) for name in COMPONENTS}
                if len(doc) and doc.text.strip()
                else {}
            )
        return json_safe(
            {
                **statistics,
                "clauses": clause_statistics(sentences, self.nlp.lang),
                "distributions": distribution_statistics(doc, sentences),
            }
        )

    def batch(self, records, accumulator, tone, style, detail, parsed):
        texts = [record["text"] for record in records]
        documents = list(self.nlp.pipe(texts, batch_size=16))
        for record, doc in zip(records, documents, strict=True):
            if detail:
                sentences = [
                    sentence_record(sentence) for sentence in doc.sents if sentence.text.strip()
                ]
                clauses = [sentence["clauses"]["count"] for sentence in sentences]
                parsed.append(
                    {
                        **record,
                        "sentences": sentences,
                        "statistics": self.statistics(doc, sentences),
                    }
                )
            else:
                clauses = [
                    clause_count(sentence) for sentence in doc.sents if sentence.text.strip()
                ]
            accumulator.add(doc, clauses)
        tone.add(texts)
        style.add(texts)

    def analyze(self, document, detail=True) -> dict:
        started = time.perf_counter()
        accumulator = CorpusStatistics(self.nlp)
        tone = self.models.tone_session()
        style = self.models.style_session()
        parsed = []
        batch = []
        characters = 0
        count = 0
        total = 0
        expected = document.get("segment_count") or 0
        for record in segments(document):
            batch.append(record)
            characters += len(record["text"])
            total += len(record["text"])
            count += 1
            if characters >= BATCH_CHARS:
                self.batch(batch, accumulator, tone, style, detail, parsed)
                progress(f"Analyzed {count}/{expected or '?'} blocks, {total} characters...")
                batch = []
                characters = 0
        if batch:
            self.batch(batch, accumulator, tone, style, detail, parsed)
        parsed_at = time.perf_counter()
        statistics = accumulator.finish()
        result = {
            "sources": document.get("sources", []),
            "segment_count": count,
            "statistics": statistics,
            "clauses": {
                "status": "enabled" if self.nlp.lang == "en" else "unsupported",
                "estimated": True,
                "method": METHOD,
                **statistics["clauses"],
            },
            "tone": tone.finish(),
            "style": style.finish(),
            "provenance": {
                "spacy_model": self.settings.spacy_model,
                "spacy_model_version": self.nlp.meta.get("version"),
                "spacy": importlib.metadata.version("spacy"),
                "textdescriptives": textdescriptives.__version__,
                "textdescriptives_distribution": "vendored subset",
                "statistics_method": TEXTDESCRIPTIVES_PAPER,
                "clause_estimation": PROVENANCE,
                "distributions": DISTRIBUTION_PROVENANCE,
                "offsets": "segment-local Python character indices; end-exclusive",
            },
            "timings": {
                "parse_seconds": parsed_at - started,
                "total_seconds": time.perf_counter() - started,
            },
        }
        if detail:
            result["segments"] = parsed
        return json_safe(result)
