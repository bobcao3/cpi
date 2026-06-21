# frozen_string_literal: true

require "set"

# Registry: maps a Block's kind to a handler that turns raw event data into an
# ordered list of Sections (title always first). Handlers are plain modules
# responding to `.sections(block)`. Built-ins are registered at the bottom;
# future sources (e.g. Terminus 2 transcripts) register their own kind. Per-tool
# policy (e.g. sh drops progress on finalize, llm_editor keeps it) lives in the
# Tool handler as a small table, so most tools need no custom handler.
module BlockRegistry
  module_function

  HANDLERS = {} # kind(Symbol) -> module responding to .sections(block)

  def register(kind, handler)
    HANDLERS[kind] = handler
  end

  def sections(block)
    (HANDLERS[block.kind] || Generic).sections(block)
  end

  # Fallback: one title section dumping the raw event.
  module Generic
    module_function
    def sections(block)
      [TranscriptBlock::Section.new(name: :title, title: block.kind.to_s,
                                    open: true, blocks: [block.event])]
    end
  end

  # Message block: title header (role + ts) then one section per content run —
  # thinking (collapsed) and text (expanded). Consecutive same-type content
  # blocks merge into one section. toolCall content is skipped (it owns its own
  # tool block downstream).
  module Message
    module_function
    def sections(block)
      m = block.event["message"] || {}
      secs = [TranscriptBlock::Section.new(name: :title, title: title_html(m), open: true, blocks: [])]
      groups = []
      Array(m["content"]).each do |b|
        next if b.is_a?(Hash) && b["type"] == "toolCall"
        ty = (b.is_a?(Hash) ? b["type"] : "text").to_s
        if groups.last && groups.last[:type] == ty then groups.last[:blocks] << b
        else groups << { type: ty, blocks: [b] } end
      end
      groups.each do |g|
        secs << TranscriptBlock::Section.new(name: g[:type].to_sym, title: preview_title(g),
                                              open: g[:type] == "text", blocks: g[:blocks])
      end
      secs
    end

    # Collapsed summary for a content run: the first line of the content, with a
    # bold "thinking" label for thinking runs (text runs show the line bare).
    # "…" is appended only when the content spans more than one line. The .prev
    # span is hidden when the section is open (the full body shows instead); a
    # text run's "text" label shows only when open (collapsed shows the line).
    def preview_title(group)
      first, more = first_line(group[:blocks])
      prev = ERB::Util.html_escape(first) + (more ? "…" : "")
      case group[:type]
      when "thinking" then %(<strong class="lbl">thinking</strong><span class="prev">#{prev}</span>).html_safe
      when "text"     then %(<pre class="line">#{prev}</pre>).html_safe
      else group[:type].html_safe
      end
    end

    # First line of a content run + whether more (non-blank) lines follow.
    def first_line(blocks)
      b = blocks.first
      text = case b.is_a?(Hash) && b["type"]
             when "thinking" then b["thinking"]
             when "text"     then b["text"]
             else b.to_s
             end.to_s
      parts = text.split("\n", 2)
      [parts.first.to_s.strip, parts[1] && !parts[1].strip.empty?]
    end

    def title_html(m)
      h = ERB::Util
      %(<span class="role">#{h.html_escape(m['role'].to_s)}</span><span class="ts">#{h.html_escape(TranscriptBlock.format_ts(m['timestamp']))}</span>).html_safe
    end
  end

  # Tool block: title (invoke + args), optional progress, optional result.
  # streaming => every section open; finalized => every section collapsed
  # (auto-collapse-once; the user is free to expand afterwards — finalize is the
  # last replace, so no later render re-collapses a manual expand).
  module Tool
    module_function
    # Tools whose progress section survives finalize (subagent transcript etc.).
    KEEP_PROGRESS = Set["llm_editor"].freeze

    def sections(block)
      ev = block.event
      done = block.state == :finalized
      err = done && ev["isError"]
      res = ev["result"]
      details = res && res["details"]
      result_blocks = res && (res["content"] || (res.is_a?(Array) ? res : nil))
      partial_blocks = block.partial && (block.partial["content"] ||
                                          (block.partial.is_a?(Array) ? block.partial : nil))

      secs = [TranscriptBlock::Section.new(name: :title, title: title(ev, done, err, details, block.updates),
                                           open: !done, blocks: block.args ? [block.args] : [])]
      if show_progress?(block.tool_name, done, partial_blocks)
        secs << TranscriptBlock::Section.new(name: :progress, title: progress_title(block.updates),
                                             open: !done, blocks: Array(partial_blocks))
      end
      if result_blocks || details
        secs << TranscriptBlock::Section.new(name: :result, title: result_title(details, err, done),
                                             open: !done, error: err, blocks: Array(result_blocks))
      end
      secs
    end

    # streaming: show progress whenever it exists; finalized: keep only if the
    # tool opts in (sh drops it — the result already carries the full output).
    def show_progress?(tool_name, done, partial_blocks)
      return false unless partial_blocks
      done ? KEEP_PROGRESS.include?(tool_name) : true
    end

    def title(ev, done, err, details, updates)
      h = ERB::Util
      s = +%(<span class="ico">#{done ? (err ? "⚠" : "✓") : "⚙"}</span>)
      s << %(<span class="tname">#{h.html_escape(ev['toolName'].to_s)}</span>)
      s << %(<span class="status">#{h.html_escape(done ? (err ? "error" : "done") : "running")}</span>)
      s << %(<span class="exit">exit #{h.html_escape(details['exitCode'].to_s)}</span>) if details
      s << %(<span class="updates">⟳#{updates}</span>) if updates.to_i.positive?
      s.html_safe
    end

    def progress_title(updates)
      "progress#{updates.to_i.positive? ? " · ⟳#{updates}" : ""}".html_safe
    end

    def result_title(details, err, done)
      t = +"result"
      t << " · exit #{details['exitCode']}" if details
      t << " · #{err ? 'error' : 'ok'}" if done
      t.html_safe
    end
  end

  # Verifier verdict (final block for completed trials): title header carries
  # reward + pass/fail; stdout (if any) is an open section.
  module Verifier
    module_function
    def sections(block)
      v = block.event
      pass = !v.reward.nil? && v.reward.to_f.positive?
      h = ERB::Util
      t = +%(<span class="kind">verifier</span>)
      t << %(<span class="reward">#{h.html_escape(v.reward.to_s)}</span>) unless v.reward.nil?
      t << %(<span class="status #{pass ? 'pass' : 'fail'}">#{pass ? 'pass' : 'fail'}</span>)
      secs = [TranscriptBlock::Section.new(name: :title, title: t.html_safe, open: true, blocks: [])]
      secs << TranscriptBlock::Section.new(name: :stdout, title: "stdout", open: true,
                                           blocks: [v.stdout]) unless v.stdout.nil?
      secs
    end
  end

  register :message, Message
  register :tool, Tool
  register :verifier, Verifier
end
