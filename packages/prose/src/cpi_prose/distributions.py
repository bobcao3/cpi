import numpy as np

from textdescriptives.components.utils import filter_tokens

PROVENANCE = {
    "quantiles": "NumPy linear interpolation, Hyndman-Fan type 7.",
    "standard_deviation": "Population standard deviation, ddof=0.",
    "source": "https://numpy.org/doc/stable/reference/generated/numpy.quantile.html",
    "sentence_length": "TextDescriptives filtered-token count per nonblank sentence.",
    "token_length": "Character count per TextDescriptives filtered token.",
    "dependency_distance": "TextDescriptives mean token-to-head distance per nonblank sentence.",
    "clauses_per_sentence": "Estimated clausal/predicative head count per nonblank sentence.",
    "aggregation": "Corpus quantiles use pooled observations, not averages of segment quantiles.",
}


def summarize(values):
    observations = (
        values.astype(np.float64, copy=False)
        if isinstance(values, np.ndarray)
        else np.fromiter(values, dtype=np.float64)
    )
    result = dict.fromkeys(("mean", "std", "p10", "p50", "p90", "min", "max"))
    if observations.size:
        if not np.isfinite(observations).all():
            raise ValueError("Distribution observations must be finite")
        p10, p50, p90 = np.quantile(observations, [0.1, 0.5, 0.9], method="linear")
        result.update(
            mean=float(np.mean(observations)),
            std=float(np.std(observations, ddof=0)),
            p10=float(p10),
            p50=float(p50),
            p90=float(p90),
            min=float(np.min(observations)),
            max=float(np.max(observations)),
        )
    return {"n": int(observations.size), **result}


def distribution_statistics(doc, sentences):
    spans = [span for span in doc.sents if span.text.strip()] if len(doc) else []
    assert len(spans) == len(sentences)
    return {
        "sentence_length": summarize(len(filter_tokens(span)) for span in spans),
        "token_length": summarize(len(token) for token in filter_tokens(doc)),
        "dependency_distance": summarize(
            span._.dependency_distance["dependency_distance_mean"] for span in spans
        ),
        "clauses_per_sentence": summarize(
            sentence["clauses"]["count"]
            for sentence in sentences
            if sentence["clauses"] is not None
        ),
    }
