/**
 * Custom footer that adds background-shell / repeat-monitor counts
 * right-aligned on the project-string line.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundCount } from "./exec.ts";
import { getRepeatCount } from "./repeat.ts";

const formatTokens = (count: number): string => {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
};

const formatCwd = (cwd: string): string => {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home || !cwd.startsWith(home)) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
};

const sanitizeStatus = (text: string): string =>
  text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();

export function setupFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const render = (width: number): string[] => {
      const lines: string[] = [];

      // Line 1: project string left, shell/monitor counts right.
      const branch = footerData.getGitBranch();
      const sessionName = ctx.sessionManager.getSessionName();
      let left = formatCwd(ctx.sessionManager.getCwd());
      if (branch) left += ` (${branch})`;
      if (sessionName) left += ` • ${sessionName}`;

      const statuses: string[] = [];
      const bgCount = getBackgroundCount();
      const rptCount = getRepeatCount();
      if (bgCount > 0) statuses.push(`#bg shells: ${bgCount}`);
      if (rptCount > 0) statuses.push(`#monitors: ${rptCount}`);
      const right = statuses.join(", ");

      let line1 = left;
      if (right) {
        const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
        line1 = left + " ".repeat(pad) + right;
      }
      lines.push(truncateToWidth(theme.fg("dim", line1), width, theme.fg("dim", "...")));

      // Line 2: token stats left, model right.
      let totalInput = 0,
        totalOutput = 0,
        totalCacheRead = 0,
        totalCacheWrite = 0,
        totalCost = 0;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const u = (entry.message as any).usage;
        if (!u) continue;
        totalInput += u.input ?? 0;
        totalOutput += u.output ?? 0;
        totalCacheRead += u.cacheRead ?? 0;
        totalCacheWrite += u.cacheWrite ?? 0;
        totalCost += u.cost?.total ?? 0;
      }
      const statsParts: string[] = [];
      if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
      if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
      if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
      if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
      const contextUsage = ctx.getContextUsage();
      if (contextUsage && contextUsage.percent != null) {
        statsParts.push(
          `${contextUsage.percent.toFixed(1)}%/${formatTokens(contextUsage.contextWindow)}`,
        );
      }
      if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

      const modelName = ctx.model?.id || "no-model";
      const providerCount = footerData.getAvailableProviderCount();
      const providerPrefix = providerCount > 1 && ctx.model ? `(${ctx.model.provider}) ` : "";
      const rightSide = providerPrefix + modelName;

      let line2 = "";
      if (statsParts.length > 0) {
        const leftText = statsParts.join(" ");
        const pad = Math.max(2, width - visibleWidth(leftText) - visibleWidth(rightSide));
        line2 = leftText + " ".repeat(pad) + rightSide;
      } else {
        line2 = " ".repeat(Math.max(0, width - visibleWidth(rightSide))) + rightSide;
      }
      lines.push(truncateToWidth(theme.fg("dim", line2), width, theme.fg("dim", "...")));

      // Line 3: extension statuses (left-aligned, like default footer).
      const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeStatus(text));
      if (statusEntries.length > 0) {
        lines.push(
          truncateToWidth(theme.fg("dim", statusEntries.join(" ")), width, theme.fg("dim", "...")),
        );
      }

      return lines;
    };

    const timer = setInterval(() => tui.requestRender(), 1000);
    return {
      invalidate() {},
      render,
      dispose() {
        clearInterval(timer);
      },
    };
  });
}
