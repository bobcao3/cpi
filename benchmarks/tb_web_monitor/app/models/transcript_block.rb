# frozen_string_literal: true

# Transcript render model. The raw NDJSON event stream (agent/pi.txt) is
# collapsed into an ordered list of render units:
#   Block — boxed, carries Sections (title always first). Agent-visible
#           content: assistant/user messages and tool calls.
#   Event — inline, no box, T+Ns timestamp. Harness lifecycle the agent never
#           sees: session / agent_* / turn_*.
# Block/Section *shape* (which sections, default open, error) is filled by
# BlockRegistry handlers; this module owns only the value types, the
# event→unit collapse, and the timestamp maths shared by helpers + handlers.
module TranscriptBlock
  module_function

  # kind: :message | :tool | :verifier; state: :streaming | :finalized.
  # event: the final event for the block (tool_execution_end / message_end /
  # Verifier::Result). args/partial/updates only for :tool.
  Block = Struct.new(:kind, :id, :state, :tool_name, :event, :args, :partial, :updates, keyword_init: true)

  # type: raw event type; t_ms/t0_ms for T+Ns (nil when unknown — "if possible").
  Event = Struct.new(:type, :t_ms, :t0_ms, :event, keyword_init: true)

  # name: :title | :thinking | :text | :progress | :result | :stdout | ...
  # title: html_safe summary string. open: default-open before user toggle.
  # error: err styling. blocks: content (String|Hash) rendered by the helper;
  # empty/nil => the section is a non-collapsible header bar.
  Section = Struct.new(:name, :title, :open, :error, :blocks, keyword_init: true) do
    def header? = blocks.nil? || blocks.empty?
  end

  # Collapse raw JSONL events into ordered render units. Tool-call lifecycles
  # merge into one Block at the start position (final event + update count);
  # message_start/update and toolResult message_end are dropped; everything
  # else becomes an inline Event. Tool state is :streaming until tool_execution_end.
  def build(events)
    finals = {}; updates = {}; targs = {}; tpartial = {}
    events.each do |ev|
      id = ev["toolCallId"]
      next unless id
      finals[id] = ev
      targs[id] ||= ev["args"] if ev["args"]
      tpartial[id] = ev["partialResult"] if ev["partialResult"]
      updates[id] = (updates[id] || 0) + (ev["type"] == "tool_execution_update" ? 1 : 0)
    end
    t0 = session_t0(events)
    seen = {}; out = []
    events.each do |ev|
      case ev["type"]
      when "tool_execution_start"
        id = ev["toolCallId"]
        next if seen[id]
        seen[id] = true
        fin = finals[id] || ev
        out << Block.new(kind: :tool, id: Transcript.tool_dom_id(id),
                         state: fin["type"] == "tool_execution_end" ? :finalized : :streaming,
                         tool_name: ev["toolName"], event: fin, args: targs[id],
                         partial: tpartial[id], updates: updates[id] || 0)
      when "tool_execution_update", "tool_execution_end", "message_start", "message_update"
        next
      when "message_end"
        next if (ev["message"] || {})["role"] == "toolResult"
        out << Block.new(kind: :message, state: :finalized, event: ev)
      else
        out << Event.new(type: ev["type"], t_ms: ts_to_ms(ev["timestamp"] || ev["ts"]),
                         t0_ms: t0, event: ev)
      end
    end
    out
  end

  # Verifier verdict as a finalized block (event holds a Verifier::Result).
  def verifier_block(v)
    Block.new(kind: :verifier, state: :finalized, event: v)
  end

  # Session T0 (ms epoch) for T+Ns offsets; nil if no session event yet.
  def session_t0(events)
    s = events.find { |e| e["type"] == "session" } or return nil
    ts_to_ms(s["timestamp"] || s["ts"])
  end

  # ms-epoch int/str OR ISO8601 -> Integer ms, or nil.
  def ts_to_ms(ts)
    return nil if ts.nil? || ts == ""
    if ts.is_a?(Numeric) then ts.to_i
    elsif ts.to_s.match?(/\A\d+\z/) then ts.to_i
    else (Time.iso8601(ts.to_s).to_r * 1000).to_i rescue nil
    end
  end

  # "T+Ns" from absolute ms + session T0; "" if either is unknown.
  def tplus_label(t_ms, t0_ms)
    return "" if t_ms.nil? || t0_ms.nil?
    "T+#{((t_ms - t0_ms) / 1000).to_i}s"
  end

  # HH:MM:SS for a block header timestamp (ms-epoch int/str or ISO8601).
  def format_ts(ts)
    return "" if ts.nil? || ts == ""
    t = if ts.is_a?(Numeric) then Time.at(ts / 1000.0)
        elsif ts.to_s.match?(/\A\d+\z/) then Time.at(ts.to_i / 1000.0)
        else Time.iso8601(ts.to_s) end
    t.strftime("%H:%M:%S")
  rescue StandardError
    ts.to_s
  end
end
