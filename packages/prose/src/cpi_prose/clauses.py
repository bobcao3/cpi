METHOD = "spacy-en-clausal-predicates-v1"
SOURCES = {
    "theory": "https://aclanthology.org/2021.cl-2.11/",
    "main": "https://universaldependencies.org/u/overview/simple-syntax.html",
    "subordinate": "https://universaldependencies.org/u/overview/complex-syntax.html",
    "coordinate": "https://universaldependencies.org/u/dep/conj.html",
    "parataxis": "https://universaldependencies.org/u/dep/parataxis.html",
    "english_labels": (
        "https://github.com/clir/clearnlp-guidelines/blob/master/md/specifications/"
        "dependency_labels.md"
    ),
    "model_labels": (
        "https://github.com/explosion/spacy-models/blob/master/meta/en_core_web_sm-3.8.0.json"
    ),
}
PROVENANCE = {
    "method": METHOD,
    "sources": SOURCES,
    "units": "Finite and nonfinite clausal/predicative heads in English dependency parses.",
    "coordination": "Verbal predicate conjuncts can share a subject and count separately.",
    "limitations": [
        "This estimator adapts clause definitions to spaCy's English labels, not a UD conversion.",
        "Compound verbal predicates may count separately; some elliptical clauses have no head.",
        "Verbal fragments and parser errors can affect counts.",
        "Adjectival complements and object predicates are not counted as extra clauses.",
        "These are not L2SCA or finite-clause counts, and estimator accuracy is not validated.",
    ],
}
CLAUSAL = frozenset({"acl", "advcl", "ccomp", "csubj", "csubjpass", "relcl", "xcomp"})
SUBJECTS = frozenset({"nsubj", "nsubjpass", "csubj", "csubjpass"})


def clause_heads(sentence):
    if sentence.doc.lang_ != "en":
        return None
    if not sentence.doc.has_annotation("DEP") or not sentence.doc.has_annotation("POS"):
        raise ValueError("Clause estimates require dependency and part-of-speech annotations")
    tokens = list(sentence)
    evidence = {
        token.i: any(child.dep_ in SUBJECTS or child.dep_ == "cop" for child in token.children)
        for token in tokens
    }
    predicates = {token.i for token in tokens if token.pos_ in {"VERB", "AUX"} or evidence[token.i]}
    heads = {}
    for token in tokens:
        relation = token.dep_
        if relation in CLAUSAL:
            heads[token.i] = "subordinate"
        elif token.i in predicates:
            if relation == "ROOT":
                heads[token.i] = "main"
            elif relation in {"pcomp", "parataxis"}:
                heads[token.i] = relation
            elif relation == "conj" and evidence[token.i]:
                heads[token.i] = "coordinate"
    pending = [token for token in tokens if token.i in heads]
    for token in pending:
        for child in token.children:
            if child.dep_ == "conj" and child.i in predicates and child.i not in heads:
                heads[child.i] = "coordinate"
                pending.append(child)
                assert len(pending) <= len(tokens)
    return heads


def clause_record(sentence):
    heads = clause_heads(sentence)
    if heads is None:
        return None
    tokens = list(sentence)
    records = [
        {
            "text": token.text,
            "start": token.idx,
            "end": token.idx + len(token),
            "dependency": token.dep_,
            "rule": heads[token.i],
        }
        for token in tokens
        if token.i in heads
    ]
    return {"count": len(records), "heads": records}


def clause_count(sentence):
    heads = clause_heads(sentence)
    return None if heads is None else len(heads)


def clause_statistics(sentences, language):
    if language != "en":
        return {"n_clauses": None, "clauses_per_sentence": None}
    records = list(sentences)
    count = sum(sentence["clauses"]["count"] for sentence in records)
    return {
        "n_clauses": count,
        "clauses_per_sentence": count / len(records) if records else None,
    }
