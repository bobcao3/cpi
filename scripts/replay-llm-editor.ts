import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  editFile,
  type EditFileResult,
} from "../extensions/llm-editor/editor.ts";
import type { DirectDiffMarkers } from "../extensions/llm-editor/direct-diff.ts";
import type { EditorMode } from "../extensions/lib/config.ts";

interface ReplayCase {
  file: string;
  instruction: string;
  source: string;
  sourceHash: string;
}

interface Trial {
  case: string;
  mode: EditorMode;
  sourceBytes: number;
  ok: boolean;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs: number;
  resultHash?: string;
  match?: "exact" | "fuzzy";
  rewrite?: boolean;
  hunks?: number;
  markers?: DirectDiffMarkers;
}

const argValue = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const positiveInt = (name: string, fallback: number): number => {
  const value = Number(argValue(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
};

const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

function parseTranscript(file: string, body: string): ReplayCase | null {
  const userTag = "## User\n\n";
  const completionTag = "\n\n## Completion\n";
  const userStart = body.indexOf(userTag);
  if (userStart < 0 || !body.startsWith("# editor editor subagent"))
    return null;
  const userEnd = body.indexOf(completionTag, userStart + userTag.length);
  if (userEnd < 0) return null;
  const user = body.slice(userStart + userTag.length, userEnd);
  const contentStart = user.indexOf("\n\n");
  const instructionTag = "\n\nInstruction: ";
  const instructionStart = user.indexOf(instructionTag, contentStart + 2);
  if (contentStart < 0 || instructionStart < 0) return null;
  const numbered = user.slice(contentStart + 2, instructionStart);
  const instructionTail = user.slice(instructionStart + instructionTag.length);
  const callStart = instructionTail.lastIndexOf("\n\nCall edit-complete");
  if (callStart < 0) return null;
  const instruction = instructionTail.slice(0, callStart).trim();
  const rows = numbered.split("\n");
  const source: string[] = [];
  for (let index = 0; index < rows.length; index++) {
    const match = /^(\d+)(?:\t|\|)(.*)$/.exec(rows[index]);
    if (!match || Number(match[1]) !== index + 1) return null;
    source.push(match[2]);
  }
  const reconstructed = source.join("\n") + (source.length ? "\n" : "");
  if (!instruction || !reconstructed) return null;
  return {
    file,
    instruction,
    source: reconstructed,
    sourceHash: hash(reconstructed),
  };
}

async function loadCases(dir: string, maxBytes: number): Promise<ReplayCase[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".md") && !name.endsWith("-retry.md"))
    .sort();
  const cases: ReplayCase[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const path = join(dir, name);
    const parsed = parseTranscript(name, await readFile(path, "utf8"));
    if (!parsed || Buffer.byteLength(parsed.source) > maxBytes) continue;
    const key = hash(parsed.source + "\0" + parsed.instruction);
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push(parsed);
  }
  return cases.sort((left, right) => left.source.length - right.source.length);
}

function sampleCases(cases: ReplayCase[], limit: number): ReplayCase[] {
  if (cases.length <= limit) return cases;
  if (limit === 1) return [cases[Math.floor(cases.length / 2)]];
  return Array.from(
    { length: limit },
    (_, index) => cases[Math.round((index * (cases.length - 1)) / (limit - 1))],
  );
}

async function runTrial(
  root: string,
  replay: ReplayCase,
  mode: EditorMode,
  index: number,
  timeoutMs: number,
  directMarkers: DirectDiffMarkers,
  provider: string,
  modelId: string,
  thinkingLevel: string,
): Promise<Trial> {
  const path = join(root, "fixture.txt");
  await writeFile(path, replay.source, "utf8");
  const start = Date.now();
  const result: EditFileResult = await editFile(path, {
    id: `replay-${index}-${mode}-${hash(JSON.stringify(directMarkers))}`,
    instruction: replay.instruction,
    provider,
    modelId,
    thinkingLevel,
    mode,
    cwd: root,
    timeoutMs,
    directMarkers,
    transcriptDir: join(root, "transcripts"),
    maxTranscripts: 1000,
    maxFileBytes: 262144,
    fuzzyMatch: true,
  });
  const elapsedMs = Date.now() - start;
  const base = {
    case: basename(replay.file, ".md"),
    mode,
    sourceBytes: Buffer.byteLength(replay.source),
    ok: result.ok,
    inputTokens: result.usage?.input,
    outputTokens: result.usage?.output,
    elapsedMs,
    markers: mode === "direct-diff" ? directMarkers : undefined,
  };
  if (!result.ok) return { ...base, error: result.error };
  const output = await readFile(path, "utf8");
  return {
    ...base,
    resultHash: hash(output),
    match: result.match,
    rewrite: result.wholeFileRewrite,
    hunks: result.applied,
  };
}

function summarize(trials: Trial[], mode: EditorMode) {
  const rows = trials.filter((trial) => trial.mode === mode);
  const measured = rows.filter(
    (trial) =>
      trial.inputTokens !== undefined && trial.outputTokens !== undefined,
  );
  const sum = (field: "inputTokens" | "outputTokens" | "elapsedMs") =>
    measured.reduce((total, trial) => total + (trial[field] ?? 0), 0);
  return {
    mode,
    trials: rows.length,
    successes: rows.filter((trial) => trial.ok).length,
    successRate: rows.length
      ? rows.filter((trial) => trial.ok).length / rows.length
      : 0,
    measured: measured.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    meanInputTokens: measured.length ? sum("inputTokens") / measured.length : 0,
    meanOutputTokens: measured.length
      ? sum("outputTokens") / measured.length
      : 0,
    meanElapsedMs: measured.length ? sum("elapsedMs") / measured.length : 0,
  };
}

async function main(): Promise<void> {
  const transcriptDir = argValue(
    "--transcripts",
    join(homedir(), ".pi", "agent", "cpi-editor"),
  );
  const limit = positiveInt("--limit", 8);
  const maxBytes = positiveInt("--max-source-bytes", 40000);
  const timeoutMs = positiveInt("--timeout-ms", 120000);
  const outputPath = argValue("--output", "");
  const caseFilter = argValue("--case", "");
  const modeArg = argValue("--mode", "both");
  const provider = argValue("--provider", "openai-codex");
  const modelId = argValue("--model", "gpt-5.6-luna");
  const thinkingLevel = argValue("--thinking", "medium");
  const markersArg = argValue("--markers", "patch");
  if (markersArg !== "angle" && markersArg !== "patch")
    throw new Error("--markers must be angle or patch");
  const directMarkers: DirectDiffMarkers = markersArg;
  const keepTemp = process.argv.includes("--keep-temp");
  if (
    modeArg !== "tool-call" &&
    modeArg !== "direct-diff" &&
    modeArg !== "both"
  )
    throw new Error("--mode must be tool-call, direct-diff, or both");
  await stat(transcriptDir);
  let available = await loadCases(transcriptDir, maxBytes);
  if (caseFilter) {
    const wanted = caseFilter.endsWith(".md")
      ? caseFilter.slice(0, -3)
      : caseFilter;
    available = available.filter(
      (replay) => basename(replay.file, ".md") === wanted,
    );
    if (available.length === 0)
      throw new Error(
        `no replayable editor transcripts for case "${caseFilter}"`,
      );
  }
  const selected = sampleCases(available, limit);
  if (selected.length === 0)
    throw new Error("no replayable editor transcripts");

  const root = await mkdtemp(join(tmpdir(), "cpi-editor-replay-"));
  const trials: Trial[] = [];
  try {
    for (let index = 0; index < selected.length; index++) {
      const replay = selected[index];
      const modes: EditorMode[] =
        modeArg === "tool-call"
          ? ["tool-call"]
          : modeArg === "direct-diff"
            ? ["direct-diff"]
            : index % 2 === 0
              ? ["tool-call", "direct-diff"]
              : ["direct-diff", "tool-call"];
      for (const mode of modes) {
        process.stderr.write(
          `[${index + 1}/${selected.length}] ${replay.file} ${mode}\n`,
        );
        const trial = await runTrial(
          root,
          replay,
          mode,
          index,
          timeoutMs,
          directMarkers,
          provider,
          modelId,
          thinkingLevel,
        );
        trials.push(trial);
        process.stderr.write(
          `  ${trial.ok ? "ok" : "FAIL"} in=${trial.inputTokens ?? "?"} out=${trial.outputTokens ?? "?"} ms=${trial.elapsedMs}\n`,
        );
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      model: `${provider}/${modelId}`,
      thinking: thinkingLevel,
      markers: directMarkers,
      source: transcriptDir,
      reconstruction: "numbered LF rows with a final newline",
      available: available.length,
      selected: selected.length,
      ...(keepTemp ? { tempRoot: root } : {}),
      summary: [
        summarize(trials, "tool-call"),
        summarize(trials, "direct-diff"),
      ],
      trials,
    };
    const json = JSON.stringify(report, null, 2) + "\n";
    if (outputPath) await writeFile(outputPath, json, "utf8");
    process.stdout.write(json);
  } finally {
    if (keepTemp) {
      process.stderr.write(`kept replay temp dir: ${root}\n`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

await main();
