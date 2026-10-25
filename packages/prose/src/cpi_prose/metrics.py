import math
from numbers import Integral, Real

from .clauses import clause_record


def json_safe(value):
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, Integral):
        return int(value)
    if isinstance(value, Real):
        return float(value) if math.isfinite(value) else None
    raise TypeError(f"unsupported metric type: {type(value).__name__}")


def sentence_record(sentence) -> dict:
    return {
        "text": sentence.text,
        "start": sentence.start_char,
        "end": sentence.end_char,
        "clauses": clause_record(sentence),
        "tokens": [
            {
                "text": token.text,
                "start": token.idx,
                "end": token.idx + len(token),
                "lemma": token.lemma_,
                "pos": token.pos_,
                "tag": token.tag_,
                "dependency": token.dep_,
                "head_start": token.head.idx,
                "morphology": token.morph.to_dict(),
            }
            for token in sentence
            if not token.is_space
        ],
    }


def numeric_deltas(current: dict, reference: dict) -> dict:
    result = {}
    for key, value in current.items():
        other = reference.get(key)
        if isinstance(value, dict) and isinstance(other, dict):
            nested = numeric_deltas(value, other)
            if nested:
                result[key] = nested
        elif type(value) in {int, float} and type(other) in {int, float}:
            result[key] = {"value": value, "reference": other, "delta": value - other}
    return result
