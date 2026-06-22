# frozen_string_literal: true

require "rexml/document"

# cpi source: specializes rendering for cpi's `sh` tool and `notification`
# custom messages.
#
# cpi renames pi's `bash` tool to `sh` and augments it with a human
# `description` (shown in the title) plus a `command` body section (the raw
# JSON args are never dumped). cpi also emits `<notification type=..>` custom
# messages (shell-complete/failed, alarm, repeat-breach/stopped) — rendered
# from their structured `details`, never the raw XML.
module Sources::Cpi
  module_function

  # cpi's shell tool is named `sh` (pi core is `bash`).
  SHELL_TOOL = "sh"

  # cpi's wait tool is named `wait_any` (pi core is `wait`).
  WAIT_TOOL = "wait_any"

  # cpi's editor tool is named `llm_editor` (pi core is `editor`).
  EDITOR_TOOL = "llm_editor"

  def tool_sections(block)
    case block.tool_name
    when SHELL_TOOL then Sh.sections(block)
    when WAIT_TOOL then WaitAny.sections(block)
    when EDITOR_TOOL then LlmEditor.sections(block)
    else nil
    end
  end

  def message_sections(block)
    m = block.event["message"] || {}
    return nil unless m["customType"] == "notification"
    Notification.sections(block)
  end

  def block_css(block)
    return nil unless block.kind == :message
    m = block.event["message"] || {}
    return nil unless m["customType"] == "notification"
    "blk notif #{(m['details'] || {})['kind']}"
  end

  # wait_any: cpi's yield-until-event primitive. Renders as a compact,
  # unexpandable title bar (no body — the empty/terminate result is not dumped).
  # The call timestamp is parsed from the result (newer cpi carries it) and
  # shown after the tool name.
  module WaitAny
    module_function

    def sections(block)
      ev = block.event
      done = block.state == :finalized
      err = done && ev["isError"]
      [TranscriptBlock::Section.new(name: :title,
                                    title: title(ev, done, err, ev["result"], block.t0_ms),
                                    open: true,
                                    blocks: [])]
    end

    def title(ev, done, err, result, t0_ms)
      s = +%(<span class="ico">#{done ? (err ? "⚠" : "✓") : "⏳"}</span>)
      s << %(<span class="tname">wait_any</span>)
      ts = stamp_ts(result, t0_ms)
      s << %(<span class="ts">#{ERB::Util.html_escape(ts)}</span>) unless ts.nil?
      s.html_safe
    end

    def stamp_ts(result, t0_ms)
      return nil unless result.is_a?(Hash)
      raw = result["timestamp"] || result["ts"] || result.dig("details", "timestamp")
      return nil if raw.nil? || raw.to_s.empty?
      stamped = TranscriptBlock.stamp(raw, t0_ms)
      stamped.to_s.empty? ? nil : stamped
    end
  end

  # sh tool: description in the title bar, command in the title body (revealed
  # on expand), no raw JSON args. Progress/result reuse the generic Tool builder
  # so the sh-drops-progress-on-finalize / exit-code / error policy stays in one
  # place.
  module Sh
    module_function

    def sections(block)
      args = block.args || {}
      ev = block.event
      done = block.state == :finalized
      err = done && ev["isError"]
      cmd = args["command"].to_s
      secs = [TranscriptBlock::Section.new(name: :title,
                                           title: title(ev, done, err, block.updates, args),
                                           open: !done,
                                           blocks: cmd.empty? ? [] : [cmd])]
      prog = BlockRegistry::Tool.progress_section(block)
      res = BlockRegistry::Tool.result_section(block)
      secs << prog if prog
      secs << res if res
      secs
    end

    def title(ev, done, err, updates, args)
      h = ERB::Util
      s = +%(<span class="ico">#{done ? (err ? "⚠" : "✓") : "⚙"}</span>)
      s << %(<span class="tname">sh</span>)
      desc = args["description"].to_s
      s << %(<span class="desc">#{h.html_escape(desc)}</span>) unless desc.empty?
      s << %(<span class="updates">⟳#{updates}</span>) if updates.to_i.positive?
      s.html_safe
    end
  end

  # notification custom message: a static title bar built from the structured
  # `details` (kind + summary; alarm appends payload.msg since its summary omits
  # the reminder text). The block css class colors the left border by kind.
  module Notification
    module_function

    ICON = { "shell-complete" => "✓", "shell-failed" => "⚠",
             "alarm" => "⏰", "repeat-breach" => "↻", "repeat-stopped" => "■" }.freeze

    def sections(block)
      m = block.event["message"] || {}
      det = m["details"] || {}
      [TranscriptBlock::Section.new(name: :title, title: title(det), open: true, blocks: [])]
    end

    def title(det)
      h = ERB::Util
      kind = det["kind"].to_s
      payload = det["payload"] || {}
      text = det["summary"].to_s
      text = "#{text} — #{payload['msg']}" if kind == "alarm" && !payload["msg"].to_s.empty?
      s = +%(<span class="ico">#{ICON.fetch(kind, "•")}</span>)
      s << %(<span class="kind">#{h.html_escape(kind)}</span>)
      s << %(<span class="sum">#{h.html_escape(text)}</span>)
      s.html_safe
    end
  end

  # llm_editor: the generic title (args) + progress are reused from
  # BlockRegistry::Tool; only the result is parsed. The <llm_editor_result>
  # XML carries command + path plus a mode-specific payload: view -> <content>
  # (line-numbered source, NN\tcode), create -> <created bytes=N/>, edit ->
  # <diff> (sign + line-number + code lines). Edit diffs render red/green with
  # dimmed line numbers.
  module LlmEditor
    module_function

    def sections(block)
      secs = [title_section(block)]
      if prog = BlockRegistry::Tool.progress_section(block)
        secs << prog
      end
      if res = result_section(block)
        secs << res
      end
      secs
    end

    def title_section(block)
      args = block.args || {}
      ev = block.event
      done = block.state == :finalized
      err = done && ev["isError"]
      TranscriptBlock::Section.new(name: :title,
                                   title: title(args, done, err, block.updates),
                                   open: !done,
                                   blocks: title_body(args))
    end

    def title(args, done, err, updates)
      s = +""
      s << %(<span class="ico">#{done ? (err ? "⚠" : "✓") : "⚙"}</span>)
      s << %(<span class="tname">llm_editor</span>)
      desc = [args["command"].to_s, args["path"].to_s].reject(&:empty?).join(" ")
      s << %(<span class="desc">#{ERB::Util.html_escape(desc)}</span>) unless desc.empty?
      s << %(<span class="updates">⟳#{updates}</span>) if updates.to_i.positive?
      s.html_safe
    end

    def title_body(args)
      return [] unless args.is_a?(Hash) && !args.empty?
      h = ERB::Util
      parts = args.except("command", "path").map do |k, v|
        next nil if v.nil? || v.to_s.empty?
        %(<div class="le-arg"><span class="k">#{h.html_escape(k)}</span><pre>#{h.html_escape(v.to_s)}</pre></div>)
      end.compact
      parts.empty? ? [] : [{ "type" => "raw", "html" => parts.join.html_safe }]
    end

    def result_section(block)
      ev = block.event
      done = block.state == :finalized
      err = done && ev["isError"]
      res = ev["result"]
      html = render_result(result_text(res))
      return BlockRegistry::Tool.result_section(block) if html.nil?
      TranscriptBlock::Section.new(name: :result,
                                   title: BlockRegistry::Tool.result_title(res && res["details"], err, done),
                                   open: !done,
                                   error: err,
                                   blocks: [{ "type" => "raw", "html" => html }])
    end

    def result_text(res)
      return nil unless res.is_a?(Hash)
      content = res["content"]
      tb = Array(content).find { |c| c.is_a?(Hash) && c["type"] == "text" }
      tb && tb["text"]
    end

    def render_result(text)
      return nil unless text.to_s.include?("<llm_editor_result")
      doc = REXML::Document.new(text) rescue nil
      return nil unless doc && doc.root
      root = doc.root
      cmd = (root.elements["command"]&.text || "").strip
      path = root.elements["path"]&.text
      h = ERB::Util
      case cmd
      when "view" then render_view(path, root.elements["content"]&.text, h)
      when "create" then render_create(path, root.elements["created"], h)
      when "edit" then render_edit(path, root, h)
      else nil
      end
    end

    def render_view(path, content, h)
      s = +%(<div class="le-hdr">view · #{h.html_escape(path.to_s)}</div>)
      if content
        s << %(<pre class="le view">)
        s << render_numbered(content, h)
        s << %(</pre>)
      end
      s.html_safe
    end

    def render_create(path, created, h)
      bytes = created&.attribute("bytes")&.value
      s = +%(<div class="le-hdr">create · #{h.html_escape(path.to_s)})
      if bytes
        s << %( · #{h.html_escape("#{bytes} bytes")})
      end
      s << %(</div>)
      s.html_safe
    end

    def render_edit(path, root, h)
      blocks = (root.elements["blocks"]&.text || "").strip
      match = (root.elements["match"]&.text || "").strip
      diff = root.elements["diff"]&.text
      s = +""
      s << %(<div class="le-hdr">edit · #{h.html_escape(path.to_s)})
      unless blocks.empty?
        s << %( · #{h.html_escape(blocks)} block#{blocks == "1" ? "" : "s"})
      end
      unless match.empty?
        s << %( · #{h.html_escape(match)})
      end
      s << %(</div>)
      if diff
        s << %(<pre class="le diff">)
        s << render_diff(diff, h)
        s << %(</pre>)
      end
      s.html_safe
    end

    def render_numbered(content, h)
      content.split("\n", -1).map do |ln|
        if m = ln.match(/\A(\d+)\t(.*)\z/)
          %(<span class="vl"><span class="ln">#{h.html_escape(m[1])}</span>\t<span class="cd">#{h.html_escape(m[2])}</span></span>)
        else
          %(<span class="vl skip">#{h.html_escape(ln)}</span>)
        end
      end.join("")
    end

    def render_diff(diff, h)
      diff.split("\n", -1).map do |ln|
        if ln.strip == "..."
          %(<span class="dl skip">#{h.html_escape(ln)}</span>)
        elsif m = ln.match(/\A([ +\-]\s*\d+) (.*)\z/)
          cls = m[1][0] == "+" ? "add" : (m[1][0] == "-" ? "del" : "ctx")
          %(<span class="dl #{cls}"><span class="ln">#{h.html_escape(m[1])}</span> <span class="cd">#{h.html_escape(m[2])}</span></span>)
        else
          %(<span class="dl ctx"><span class="cd">#{h.html_escape(ln)}</span></span>)
        end
      end.join("")
    end
  end
end
