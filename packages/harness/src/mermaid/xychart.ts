import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { color_xychart } from "./xychart-colors.ts";

interface Series {
  kind: "bar" | "line";
  name: string;
  values: string[];
}

export interface XYChartPlan {
  source: string;
  title?: string;
  x_title?: string;
  y_title?: string;
  labels: string[];
  indexed: boolean;
  horizontal: boolean;
  series: Series[];
}

function quoted(value: string): string {
  const text: unknown = JSON.parse(value);
  if (typeof text !== "string") throw new Error("chart_labels");
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new Error("controls");
  return text;
}

function categories(source: string): string[] {
  const labels: string[] = [];
  let start = 0;
  let inside = false;
  let escape = false;
  for (let index = 0; index <= source.length; index++) {
    const char = source[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (inside && char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') inside = !inside;
    if ((char === "," && !inside) || index === source.length) {
      const token = source.slice(start, index).trim();
      if (!token || inside) throw new Error("chart_labels");
      const label = token.startsWith('"') ? quoted(token) : token;
      if (/[\u0000-\u001f\u007f-\u009f]/.test(label))
        throw new Error("controls");
      labels.push(label);
      start = index + 1;
    }
  }
  return labels;
}

export function prepare_xychart(source: string, width: number): XYChartPlan {
  const plan: XYChartPlan = {
    source: "",
    labels: [],
    indexed: false,
    horizontal: /^xychart(?:-beta)?\s+horizontal\b/.test(source),
    series: [],
  };
  const counts = { bar: 0, line: 0 };
  const lines = source.split("\n");
  let category_line = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const title = line.match(/^\s*title\s+("(?:\\.|[^"\\])*")\s*$/);
    if (title) {
      plan.title = quoted(title[1]);
      lines[index] = "";
      continue;
    }
    const axis = line.match(
      /^\s*([xy])-axis(?:\s+("(?:\\.|[^"\\])*"))?\s*(.*)$/,
    );
    if (axis) {
      if (axis[2]) {
        if (axis[1] === "x") plan.x_title = quoted(axis[2]);
        else plan.y_title = quoted(axis[2]);
        lines[index] = axis[3] ? `${axis[1]}-axis ${axis[3]}` : "";
      }
      const list = axis[3].match(/^\[(.*)\]\s*$/);
      if (axis[1] === "x" && list) {
        plan.labels = categories(list[1]);
        category_line = index;
      }
      continue;
    }
    const series = line.match(/^\s*(bar|line)\s+\[([^\]]*)\]\s*$/);
    if (series) {
      const kind = series[1] as Series["kind"];
      const values = series[2].split(",").map((value) => value.trim());
      if (
        values.some(
          (value) =>
            !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ||
            !Number.isFinite(Number(value)),
        )
      )
        throw new Error("chart_values");
      plan.series.push({ kind, name: `${kind} ${++counts[kind]}`, values });
    }
  }
  if (plan.labels.length) {
    if (
      plan.series.some((series) => series.values.length !== plan.labels.length)
    )
      throw new Error("chart_lengths");
    const band = Math.floor(
      Math.max(60, plan.labels.length * 6) / plan.labels.length,
    );
    plan.indexed = plan.labels.some(
      (label) =>
        /[,\[\]]/.test(label) ||
        label !== label.trim() ||
        (plan.horizontal
          ? visibleWidth(label) + 65 > width
          : visibleWidth(label) >= band),
    );
    const labels = plan.indexed
      ? plan.labels.map((_label, index) => String(index + 1))
      : plan.labels;
    lines[category_line] = `x-axis [${labels.join(", ")}]`;
  }
  plan.source = lines.filter((line) => line.trim()).join("\n");
  return plan;
}

export function format_xychart(
  plan: XYChartPlan,
  plot: string,
  width: number,
  theme: Theme,
): string {
  const rows: string[] = [];
  const append = (value: string, bold = false) => {
    for (const row of wrapTextWithAnsi(value, width)) {
      const text = theme.fg("text", row);
      rows.push(bold ? theme.bold(text) : text);
    }
  };
  if (plan.title) append(plan.title, true);
  if (plan.y_title) append(plan.y_title);
  const colored = color_xychart(plan, plot, theme);
  const plot_rows = colored.plot.split("\n").map((row) => row.trimEnd());
  const plot_width = plot_rows.reduce(
    (maximum, row) => Math.max(maximum, visibleWidth(row)),
    0,
  );
  if (plan.x_title)
    plot_rows.push(
      ...wrapTextWithAnsi(plan.x_title, Math.max(1, plot_width)).map((row) =>
        theme.fg("text", row),
      ),
    );
  const entries: { text: string; index: number }[] = [];
  if (plan.indexed || plan.series.some((series) => series.kind === "bar")) {
    if (plan.labels.length) {
      for (const [index, label] of plan.labels.entries()) {
        const values = plan.series.map((series) =>
          plan.series.length === 1
            ? series.values[index]
            : `${series.name}=${series.values[index]}`,
        );
        entries.push({
          text: `${plan.indexed ? `${index + 1}. ` : ""}${label}: ${values.join(", ")}`,
          index,
        });
      }
    } else {
      for (const series of plan.series)
        entries.push({
          text: `${series.name}: [${series.values.join(", ")}]`,
          index: -1,
        });
    }
  }
  const key_rows = (columns: number) =>
    entries.flatMap(({ text, index }) =>
      wrapTextWithAnsi(text, Math.max(1, columns - 3)).map((row, line) =>
        theme.style(`${line ? "   " : ""}${row}`, {
          fg: colored.colors[index] ?? theme.colors.text,
        }),
      ),
    );
  const key_width = entries.reduce(
    (maximum, entry) => Math.max(maximum, visibleWidth(entry.text)),
    0,
  );
  const right_room = width - plot_width - 3;
  if (entries.length && right_room >= Math.min(key_width, 24)) {
    const key = key_rows(right_room);
    for (let row = 0; row < Math.max(plot_rows.length, key.length); row++) {
      const left = plot_rows[row] ?? "";
      rows.push(
        `${left}${" ".repeat(plot_width - visibleWidth(left) + 3)}${key[row] ?? ""}`,
      );
    }
  } else {
    rows.push(...plot_rows);
    if (entries.length) rows.push("", ...key_rows(width));
  }
  return rows.join("\n");
}
