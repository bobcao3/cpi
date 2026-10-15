const max_title_graphemes = 160;
const max_title_code_units = 4096;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function title_graphemes(title: string): string[] | undefined {
  if (title.length > max_title_code_units) return undefined;
  const graphemes: string[] = [];
  for (const { segment } of segmenter.segment(title)) {
    if (graphemes.length === max_title_graphemes) return undefined;
    graphemes.push(segment);
  }
  return graphemes;
}

export function shortest_title_mutations(
  source: string,
  target: string,
): readonly string[] {
  if (source === target) return [];
  const source_graphemes = title_graphemes(source);
  if (!source_graphemes) return [target];
  const target_graphemes = title_graphemes(target);
  if (!target_graphemes) return [target];

  const source_length = source_graphemes.length;
  const target_length = target_graphemes.length;
  const distances = Array.from(
    { length: source_length + 1 },
    () => new Uint16Array(target_length + 1),
  );
  for (let i = source_length; i >= 0; i--) {
    for (let j = target_length; j >= 0; j--) {
      if (i === source_length) distances[i]![j] = target_length - j;
      else if (j === target_length) distances[i]![j] = source_length - i;
      else if (source_graphemes[i] === target_graphemes[j])
        distances[i]![j] = distances[i + 1]![j + 1]!;
      else
        distances[i]![j] =
          1 +
          Math.min(
            distances[i + 1]![j + 1]!,
            distances[i + 1]![j]!,
            distances[i]![j + 1]!,
          );
    }
  }

  const current = [...source_graphemes];
  const frames: string[] = [];
  let i = 0;
  let j = 0;
  while (i < source_length || j < target_length) {
    if (
      i < source_length &&
      j < target_length &&
      source_graphemes[i] === target_graphemes[j]
    ) {
      i++;
      j++;
      continue;
    }
    const remaining = distances[i]![j]! - 1;
    if (
      i < source_length &&
      j < target_length &&
      distances[i + 1]![j + 1] === remaining
    ) {
      current[j] = target_graphemes[j]!;
      i++;
      j++;
    } else if (i < source_length && distances[i + 1]![j] === remaining) {
      current.splice(j, 1);
      i++;
    } else {
      current.splice(j, 0, target_graphemes[j]!);
      j++;
    }
    frames.push(current.join(""));
  }
  return frames;
}
