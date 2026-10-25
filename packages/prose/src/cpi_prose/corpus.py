import math
from array import array
from collections import Counter

import numpy as np
from pyphen import Pyphen

from textdescriptives.components.utils import all_upos_tags, filter_tokens

from .clauses import clause_count
from .distributions import summarize


def syllables_available(language):
    try:
        Pyphen(lang=language)
        return True
    except KeyError:
        return False


def histogram(counter):
    if not counter:
        return np.empty(0, dtype=np.float64)
    return np.repeat(
        np.fromiter(counter.keys(), dtype=np.float64),
        np.fromiter(counter.values(), dtype=np.int64),
    )


def mean(counter):
    total = sum(value * count for value, count in counter.items())
    count = sum(counter.values())
    return total / count if count else math.nan


def deviation(counter):
    count = sum(counter.values())
    if not count:
        return math.nan
    average = mean(counter)
    return math.sqrt(sum((value - average) ** 2 * n for value, n in counter.items()) / count)


def median(counter):
    values = histogram(counter)
    return float(np.median(values)) if values.size else math.nan


def values(counter):
    return histogram(counter)


class CorpusStatistics:
    def __init__(self, nlp):
        self.language = nlp.lang
        self.syllables = syllables_available(nlp.lang)
        self.token_lengths = Counter()
        self.sentence_lengths = Counter()
        self.syllable_counts = Counter()
        self.pos_counts = Counter()
        self.unique = set()
        self.sentence_observations = Counter()
        self.clause_observations = Counter()
        self.dependency_observations = array("d")
        self.n_tokens = 0
        self.n_tokens_all = 0
        self.n_sentences = 0
        self.n_clauses = 0
        self.n_clause_sentences = 0
        self.n_characters = 0
        self.hard_words = 0
        self.long_words = 0
        self.entropy = 0.0
        self.entropy_valid = True
        self.dependency_means = array("d")
        self.adjacent_proportions = array("d")

    def add(self, doc, clauses=None):
        tokens = filter_tokens(doc)
        self.n_tokens += len(tokens)
        self.n_tokens_all += len(doc)
        self.n_characters += len(doc.text.replace(" ", ""))
        self.unique.update(token.lower_ for token in tokens)
        for token in tokens:
            length = len(token)
            self.token_lengths[length] += 1
            if length > 6:
                self.long_words += 1
        if self.syllables:
            counts = doc._._n_syllables
            self.syllable_counts.update(counts)
            self.hard_words += sum(1 for count in counts if count >= 3)
        for token in doc:
            self.pos_counts[token.pos_] += 1
        index = 0
        for sentence in doc.sents:
            length = len(filter_tokens(sentence))
            self.sentence_lengths[length] += 1
            self.n_sentences += 1
            dependency = sentence._.dependency_distance
            self.dependency_means.append(dependency["dependency_distance_mean"])
            self.adjacent_proportions.append(dependency["prop_adjacent_dependency_relation"])
            if not sentence.text.strip():
                continue
            self.sentence_observations[length] += 1
            self.dependency_observations.append(dependency["dependency_distance_mean"])
            count = clause_count(sentence) if clauses is None else clauses[index]
            index += 1
            if count is None:
                continue
            self.n_clauses += count
            self.n_clause_sentences += 1
            self.clause_observations[count] += 1
        if clauses is not None:
            assert index == len(clauses), "Clause counts must match nonblank sentences"
        information = doc._.information_theory
        entropy = information["entropy"]
        if entropy is None or not math.isfinite(entropy):
            self.entropy_valid = False
        else:
            self.entropy += entropy

    def descriptive(self):
        average_tokens = mean(self.token_lengths)
        average_sentences = mean(self.sentence_lengths)
        average_syllables = mean(self.syllable_counts) if self.syllables else math.nan
        return {
            "n_tokens": self.n_tokens,
            "n_unique_tokens": len(self.unique),
            "proportion_unique_tokens": (
                len(self.unique) / self.n_tokens if self.n_tokens else math.nan
            ),
            "n_characters": self.n_characters,
            "n_sentences": self.n_sentences,
            "token_length_mean": average_tokens,
            "token_length_median": median(self.token_lengths),
            "token_length_std": deviation(self.token_lengths),
            "sentence_length_mean": average_sentences,
            "sentence_length_median": median(self.sentence_lengths),
            "sentence_length_std": deviation(self.sentence_lengths),
            "syllables_per_token_mean": average_syllables,
            "syllables_per_token_median": (
                median(self.syllable_counts) if self.syllables else math.nan
            ),
            "syllables_per_token_std": (
                deviation(self.syllable_counts) if self.syllables else math.nan
            ),
        }

    def readability(self):
        average_sentences = mean(self.sentence_lengths)
        average_syllables = mean(self.syllable_counts)
        average_tokens = mean(self.token_lengths)
        sentences = self.n_sentences
        tokens = self.n_tokens
        hard = self.hard_words
        long = self.long_words
        unavailable = not self.syllables
        return {
            "flesch_reading_ease": (
                math.nan
                if unavailable or not average_sentences or not average_syllables
                else 206.835 - 1.015 * average_sentences - 84.6 * average_syllables
            ),
            "flesch_kincaid_grade": (
                math.nan
                if unavailable or not average_sentences or not average_syllables
                else 0.39 * average_sentences + 11.8 * average_syllables - 15.59
            ),
            "smog": (
                math.nan
                if unavailable or sentences < 3
                else 1.043 * (30 * hard / sentences) ** 0.5 + 3.1291
            ),
            "gunning_fog": (
                math.nan
                if unavailable or not tokens
                else 0.4 * (average_sentences + hard / tokens * 100)
            ),
            "automated_readability_index": (
                math.nan
                if not self.n_tokens_all
                else 4.71 * average_tokens + 0.5 * average_sentences - 21.43
            ),
            "coleman_liau_index": (
                math.nan
                if not tokens
                else 0.0588 * average_tokens * 100 - 0.296 * sentences / tokens * 100 - 15.8
            ),
            "lix": (math.nan if not tokens else average_sentences + long / tokens * 100),
            "rix": math.nan if not tokens else long / sentences,
        }

    def dependency(self):
        if not self.dependency_means:
            return dict.fromkeys(
                (
                    "dependency_distance_mean",
                    "dependency_distance_std",
                    "prop_adjacent_dependency_relation_mean",
                    "prop_adjacent_dependency_relation_std",
                ),
                math.nan,
            )
        distances = np.frombuffer(self.dependency_means, dtype=np.float64)
        adjacent = np.frombuffer(self.adjacent_proportions, dtype=np.float64)
        return {
            "dependency_distance_mean": float(np.mean(distances)),
            "dependency_distance_std": float(np.std(distances)),
            "prop_adjacent_dependency_relation_mean": float(np.mean(adjacent)),
            "prop_adjacent_dependency_relation_std": float(np.std(adjacent)),
        }

    def proportions(self):
        if not self.n_tokens_all:
            return {f"pos_prop_{tag}": math.nan for tag in all_upos_tags}
        return {
            f"pos_prop_{tag}": self.pos_counts[tag] / self.n_tokens_all for tag in all_upos_tags
        }

    def information(self):
        if not self.entropy_valid:
            return {
                "entropy": math.nan,
                "perplexity": math.nan,
                "per_word_perplexity": math.nan,
            }
        try:
            perplexity = math.exp(self.entropy)
        except OverflowError:
            perplexity = math.inf
        return {
            "entropy": self.entropy,
            "perplexity": perplexity,
            "per_word_perplexity": (
                perplexity / self.n_tokens_all if self.n_tokens_all else math.nan
            ),
        }

    def clauses(self):
        if self.language != "en" or not self.n_clause_sentences:
            return {"n_clauses": None, "clauses_per_sentence": None}
        return {
            "n_clauses": self.n_clauses,
            "clauses_per_sentence": self.n_clauses / self.n_clause_sentences,
        }

    def finish(self):
        distributions = {
            "sentence_length": summarize(values(self.sentence_observations)),
            "token_length": summarize(values(self.token_lengths)),
            "dependency_distance": summarize(self.dependency_observations),
            "clauses_per_sentence": summarize(values(self.clause_observations)),
        }
        if not self.n_tokens_all:
            return {"clauses": self.clauses(), "distributions": distributions}
        return {
            "descriptive_stats": self.descriptive(),
            "readability": self.readability(),
            "dependency_distance": self.dependency(),
            "pos_proportions": self.proportions(),
            "information_theory": self.information(),
            "clauses": self.clauses(),
            "distributions": distributions,
        }
