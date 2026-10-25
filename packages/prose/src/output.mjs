const metrics = [
  ["Word tokens", "descriptive_stats", "n_tokens"],
  ["Sentences", "descriptive_stats", "n_sentences"],
  ["Clauses (estimated)", "clauses", "n_clauses"],
  ["Flesch reading ease", "readability", "flesch_reading_ease"],
  ["Flesch-Kincaid grade", "readability", "flesch_kincaid_grade"],
];

const distributions = [
  ["Sentence length", "sentence_length"],
  ["Clauses per sentence", "clauses_per_sentence"],
  ["Token length", "token_length"],
  ["Dependency distance", "dependency_distance"],
];

function number(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "unavailable";
}

export function render(result) {
  if (!result.analysis) {
    if (Object.hasOwn(result, "running"))
      return result.running
        ? `Server running (PID ${result.pid}${result.stale ? ", update pending" : ""}).\n`
        : "Server stopped.\n";
    return `Reference cache: ${result.entries} entries, ${number(result.bytes)} bytes.\n`;
  }
  const analysis = result.analysis,
    reference = result.reference;
  const lines = ["Prose analysis", ""];
  if (analysis.sources?.length)
    lines.push(
      `Input: ${analysis.sources.map((source) => source.path).join(", ")}`,
    );
  lines.push(
    `Comment/text blocks: ${analysis.segment_count ?? analysis.segments?.length ?? 0}`,
  );
  if (reference) {
    lines.push(
      `Reference: ${reference.sources?.length ?? 0} files, ${reference.segments} blocks`,
    );
  }
  lines.push(
    "",
    reference
      ? "Metric                          Input     Reference"
      : "Metric                          Input",
  );
  for (const [label, group, key] of metrics) {
    const current = number(analysis.statistics[group]?.[key]);
    const other = reference ? number(reference.statistics[group]?.[key]) : null;
    lines.push(
      label.padEnd(31) +
        current.padStart(9) +
        (other === null ? "" : other.padStart(14)),
    );
  }
  lines.push("", "Pacing");
  for (const [label, corpus] of [
    ["Input", analysis],
    ["Reference", reference],
  ]) {
    if (!corpus) continue;
    lines.push(
      "",
      label,
      "Metric".padEnd(28) +
        ["Mean", "SD", "p10", "p90"].map((name) => name.padStart(12)).join(""),
    );
    for (const [name, key] of distributions) {
      const values = corpus.statistics.distributions?.[key];
      lines.push(
        name.padEnd(28) +
          ["mean", "std", "p10", "p90"]
            .map((statistic) => number(values?.[statistic]).padStart(12))
            .join(""),
      );
    }
  }
  if (analysis.style.status === "enabled" && reference) {
    lines.push(
      "",
      `Style cosine similarity: ${number(result.comparison.style_cosine_similarity, 4)}`,
    );
  }
  if (analysis.tone.status === "enabled") {
    lines.push("", "Tone");
    for (const [label, score] of Object.entries(analysis.tone.scores)) {
      const other = reference?.tone.scores?.[label];
      lines.push(
        label.padEnd(20) +
          number(score).padStart(9) +
          (other === undefined ? "" : number(other).padStart(14)),
      );
    }
  }
  if (analysis.clauses.status !== "enabled")
    lines.push("", "Clause counts unavailable.");
  return lines.join("\n") + "\n";
}
