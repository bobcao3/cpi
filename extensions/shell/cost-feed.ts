/**
 * Feed the cost ledger from completed `subagent` sh commands.
 *
 * Regular subagents (launched via the `subagent` script through the `sh` tool)
 * print a `summary: ... in=.. out=.. cost=$..` line at conclusion — already the
 * subagent's full subtree usage (subagent-transcript folds its own descendants
 * into it). Parsing it here and calling addSubagentUsage records the child on the
 * parent's ledger, which subagent-transcript then folds into the parent's own
 * emitted summary. Recursion bottoms out as addition; no double counting.
 *
 * Catches both inline (result text, within waitfor) and backgrounded (log tail)
 * completions. Non-subagent commands never match the summary format → no-op.
 * Pure leaf: lib/cost-ledger + lib/footer only.
 */

import { addSubagentUsage, parseSummaryUsage, parseFileSummary } from "../lib/cost-ledger.ts";
import { requestFooterRender } from "../lib/footer.ts";

// Gate feeders on the sh command being a subagent invocation so that merely
// reading a subagent's log (cat/tail/rg) does not re-add its cost.
const SUBAGENT_CMD_RE = /\bsubagent\b/;

/** Inline (within waitfor) completion: parse the captured result text. */
export function feedCostInline(text: string | undefined, command: string | undefined): void {
  if (!SUBAGENT_CMD_RE.test(command ?? "")) return;
  const u = parseSummaryUsage(text ?? "");
  if (!u) return;
  addSubagentUsage(u);
  requestFooterRender();
}

/** Backgrounded completion: parse the tail of the captured log file. */
export function feedCostCompletion(logPath: string | undefined, command: string | undefined): void {
  if (!SUBAGENT_CMD_RE.test(command ?? "")) return;
  if (!logPath) return;
  const u = parseFileSummary(logPath);
  if (!u) return;
  addSubagentUsage(u);
  requestFooterRender();
}
