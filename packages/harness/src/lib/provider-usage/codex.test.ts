import { test, expect } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
  backgroundAnsi,
  colorToRgb,
  indexedColor,
  rgbColor,
  visibleWidth,
  type Color,
} from "@earendil-works/pi-tui";
import { getThemeByName } from "@earendil-works/pi-coding-agent";
import { codexUsage, parseUsageReport } from "./codex.ts";
const prefix = "openai-codex ";

function getActiveBackgroundAnsi(text: string): string {
  const last = [...text.matchAll(/\x1b\[(?:48;(?:2|5);[\d;]+|49|0)m/g)].at(
    -1,
  )?.[0];
  return last?.startsWith("\x1b[48;") ? last : "";
}

function luminance(color: Color): number {
  const { r, g, b } = colorToRgb(color);
  const channels = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

for (const name of ["dark", "light"]) {
  test(`${name}: quota percentages fit inside the compact bar and countdown remains separate`, () => {
    const theme = getThemeByName(name)!;
    const report = parseUsageReport(
      {
        rate_limit: {
          primary_window: { used_percent: 50 },
          secondary_window: { used_percent: 86, reset_after_seconds: 3600 },
        },
      },
      1000,
    )!;
    const value = codexUsage.format(report, 1000, theme)!;
    const plain = stripVTControlCharacters(value);
    const bar = plain.slice(prefix.length, plain.length - " 1h".length);
    expect(visibleWidth(bar)).toBeLessThanOrEqual(16);
    expect(stripVTControlCharacters(bar).match(/\d+%/g)).toEqual([
      "50%",
      "14%",
    ]);
    expect(stripVTControlCharacters(bar)).toMatch(/^[ 0-9%]+$/);
    expect(
      getActiveBackgroundAnsi(value.slice(0, value.indexOf("openai-codex"))),
    ).toBe("");
    expect(getActiveBackgroundAnsi(value.slice(0, value.indexOf("1h")))).toBe(
      "",
    );
    expect(getActiveBackgroundAnsi(value)).toBe("");
    expect(plain).toMatch(/^openai-codex .* 1h$/);
    const text_only = codexUsage.format(report, 1000)!;
    expect(text_only).toBe(plain);
    expect(text_only).not.toContain("\x1b");
  });

  test(`${name}: full and depleted quota ranges use contiguous backgrounds without block glyphs`, () => {
    const theme = getThemeByName(name)!;
    const single = (usedPercent: number) =>
      codexUsage.format({ primary: { usedPercent } }, 0, theme)!;
    const full = single(0);
    const empty = single(100);
    expect(stripVTControlCharacters(full).slice(prefix.length).trim()).toBe(
      "100%",
    );
    expect(stripVTControlCharacters(empty).slice(prefix.length).trim()).toBe(
      "0%",
    );
    expect(visibleWidth(full) - visibleWidth(prefix)).toBeLessThanOrEqual(8);
    expect(visibleWidth(empty)).toBe(visibleWidth(full));
    const primaryBackground = backgroundAnsi(
      theme.colors.success,
      theme.getColorMode(),
    );
    const secondaryBackground = backgroundAnsi(
      theme.colors.warning,
      theme.getColorMode(),
    );
    const emptyBackground = getActiveBackgroundAnsi(
      empty.slice(0, empty.indexOf("0%")),
    );
    const match = emptyBackground.match(/\x1b\[48;(2|5);([\d;]+)m/);
    if (!match) throw new Error("Expected an explicit track background color");
    const channels = match[2].split(";").map(Number);
    const trackColor =
      match[1] === "2"
        ? rgbColor(channels[0], channels[1], channels[2])
        : indexedColor(channels[0]);
    const trackLuminance = luminance(trackColor);
    const surroundingLuminance = luminance(theme.colors.customMessageBg);
    expect(
      (Math.max(trackLuminance, surroundingLuminance) + 0.05) /
        (Math.min(trackLuminance, surroundingLuminance) + 0.05),
    ).toBeGreaterThanOrEqual(1.5);
    expect(primaryBackground).not.toBe(theme.getBgAnsi("customMessageBg"));
    expect(full.split(primaryBackground).length - 1).toBe(1);
    expect(empty.split(emptyBackground).length - 1).toBe(1);
    expect(full).not.toContain(emptyBackground);
    expect(empty).not.toContain(primaryBackground);
    const low = single(99);
    expect(stripVTControlCharacters(low).slice(prefix.length).trim()).toBe(
      "1%",
    );
    expect(low).toContain(primaryBackground);
    expect(low).toContain(emptyBackground);
    const half = single(50);
    expect(half).toContain(primaryBackground);
    expect(half).toContain(emptyBackground);
    expect(stripVTControlCharacters(half)).toContain("50%");
    expect(
      (visibleWidth(half.slice(0, half.indexOf(emptyBackground))) -
        visibleWidth(prefix)) *
        2,
    ).toBe(visibleWidth(half) - visibleWidth(prefix));
    const dual = codexUsage.format(
      { primary: { usedPercent: 0 }, secondary: { usedPercent: 0 } },
      0,
      theme,
    )!;
    expect(dual).toContain(primaryBackground);
    expect(dual).toContain(secondaryBackground);
    expect(stripVTControlCharacters(dual).match(/\d+%/g)).toEqual([
      "100%",
      "100%",
    ]);
  });
}
