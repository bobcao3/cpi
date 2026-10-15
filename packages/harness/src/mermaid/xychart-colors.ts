import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  foregroundAnsi,
  getTerminalColorMode,
  okhslColor,
  visibleWidth,
  type Color,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { XYChartPlan } from "./xychart.ts";

export function color_xychart(
  plan: XYChartPlan,
  plot: string,
  theme: Theme,
): { plot: string; colors: Color[] } {
  if (
    plan.series.length !== 1 ||
    plan.series[0].kind !== "bar" ||
    !plan.labels.length
  )
    return { plot, colors: [] };
  const lines = plot.split("\n");
  const plain = lines.map(stripVTControlCharacters);
  let axis_row = -1;
  let centers: number[] = [];
  for (const [row, line] of plain.entries()) {
    const ticks = Array.from(line.matchAll(/┬/g), (match) => match.index!);
    if (ticks.length > centers.length) {
      axis_row = row;
      centers = ticks;
    }
  }
  const axis_column =
    plain.find((line) => line.includes("│"))?.lastIndexOf("│") ?? -1;
  if (plan.horizontal ? axis_column < 0 : centers.length !== plan.labels.length)
    return { plot, colors: [] };
  const colors = plan.labels.map((_label, index) =>
    okhslColor(
      (250 + index * 137.508) % 360,
      0.75,
      theme.appearance === "dark" ? 0.72 : 0.4,
    ),
  );
  const prefixes = colors.map((color) =>
    foregroundAnsi(color, getTerminalColorMode()),
  );
  let group = -1;
  let previous = false;
  const colored = lines.map((line, row) => {
    const has_bar =
      plan.horizontal && plain[row].slice(axis_column + 1).includes("█");
    if (has_bar && !previous) group++;
    previous = has_bar;
    let column = 0;
    let active = "";
    let result = "";
    for (const [token] of line.matchAll(/\x1b\[[\d;]*m|█+|[^\x1b█]+/gu)) {
      if (token.startsWith("\x1b")) {
        active = token === "\x1b[0m" || token === "\x1b[39m" ? "" : token;
        result += token;
        continue;
      }
      const is_bar =
        token.startsWith("█") &&
        (plan.horizontal ? column > axis_column : row < axis_row);
      if (is_bar) {
        const middle = column + (token.length - 1) / 2;
        let index = group;
        if (!plan.horizontal) {
          index = 0;
          for (let candidate = 1; candidate < centers.length; candidate++) {
            if (
              Math.abs(centers[candidate] - middle) <
              Math.abs(centers[index] - middle)
            )
              index = candidate;
          }
        }
        result += prefixes[index]
          ? `${prefixes[index]}${token}\x1b[0m${active}`
          : token;
      } else result += token;
      column += visibleWidth(token);
    }
    return result;
  });
  if (plan.horizontal && group + 1 !== plan.labels.length)
    return { plot, colors: [] };
  return { plot: colored.join("\n"), colors };
}
