/**
 * Streaming markdown transcript writer.
 *
 * When `PI_TRANSCRIPT_MD` is set (the subagent.sh helper sets it), this writes a
 * friendly markdown transcript LIVE as the session runs — one block appended per
 * message as it completes — so an orchestrating agent can tail it while the
 * subagent is still working. No post-hoc `.jsonl` parsing.
 *
 * Sessions launched without `PI_TRANSCRIPT_MD` (e.g. the main agent itself) are
 * a no-op.
 */

import { appendFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MD_PATH = process.env.PI_TRANSCRIPT_MD;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
}

// Render one AgentMessage (same shape as the persisted jsonl record) to markdown.
function renderMessage(m: any): string {
  const out: string[] = [];
  const role = m?.role;
  if (role === "user") {
    out.push("## 👤 User", "", textOf(m.content) || "_(no text)_", "");
  } else if (role === "assistant") {
    const tag = m.model ? ` _(${m.provider ?? "?"}/${m.model})_` : "";
    out.push(`## 🤖 Assistant${tag}`, "");
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === "thinking" && c.thinking) {
        out.push("> 💭 " + String(c.thinking).replace(/\n/g, "\n> "), "");
      } else if (c.type === "text" && c.text) {
        out.push(c.text, "");
      } else if (c.type === "toolCall") {
        const args =
          typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {});
        out.push(`🔧 **${c.name}** \`${c.id ?? ""}\``, "```json", args, "```", "");
      }
    }
  } else if (role === "toolResult") {
    const flag = m.isError ? " ❌" : "";
    out.push(
      `↳ **result** ${m.toolName ?? ""} \`${m.toolCallId ?? ""}\`${flag}`,
      "",
      "```",
      textOf(m.content) || "(no output)",
      "```",
      "",
    );
  }
  return out.length ? out.join("\n") + "\n" : "";
}

export default async function (pi: ExtensionAPI) {
  if (!MD_PATH) return; // only active when a target path is provided

  const append = (s: string) => {
    try {
      appendFileSync(MD_PATH, s);
    } catch {
      // best effort; never break the session over transcript I/O
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Header once per file; on resume we just keep appending.
    if (!existsSync(MD_PATH)) {
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
      append(`# Subagent transcript\n\ncwd: \`${ctx.cwd}\`  •  model: ${model}\n\n`);
    }
  });

  pi.on("message_end", async (event) => {
    append(renderMessage((event as { message: unknown }).message));
  });
}
