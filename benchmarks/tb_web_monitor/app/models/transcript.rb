# frozen_string_literal: true

# Port of server.ts pushTranscript (backfill path): parse complete
# newline-delimited JSON events from agent/pi.txt. A trailing partial line
# (no newline) is excluded, matching the Bun server's lastNewline logic.
module Transcript
  module_function

  def events(job, trial)
    path = JobsDir.transcript_path(job, trial)
    return [] unless File.exist?(path)

    text = File.binread(path).force_encoding("UTF-8")
    last_nl = text.rindex("\n")
    return [] unless last_nl

    text[0..last_nl].split("\n").map do |ln|
      next if ln.empty?
      JSON.parse(ln)
    rescue JSON::ParserError
      nil
    end.compact
  end

  # Delta read for live streaming: new complete events since byte `offset`.
  # Returns [events, new_offset]. Resets offset to 0 if the file shrank.
  def since(job, trial, offset)
    path = JobsDir.transcript_path(job, trial)
    return [[], offset] unless File.exist?(path)

    size = File.size(path)
    offset = 0 if size < offset
    return [[], offset] if size == offset

    buf = File.binread(path, size - offset, offset).force_encoding("UTF-8")
    last_nl = buf.rindex("\n")
    return [[], offset] unless last_nl

    consumed = offset + last_nl + 1
    events = buf[0..last_nl].split("\n").map do |ln|
      next if ln.empty?
      JSON.parse(ln)
    rescue JSON::ParserError
      nil
    end.compact
    [events, consumed]
  rescue Errno::ENOENT
    [[], offset]
  end

  # Bytes consumed up to the last newline (offset for live streaming).
  def size(job, trial)
    path = JobsDir.transcript_path(job, trial)
    return 0 unless File.exist?(path)
    File.binread(path).force_encoding("UTF-8").rindex("\n").then { |i| i ? i + 1 : 0 }
  end

  # Stable DOM id for a tool-call block (toolCallIds contain dots/colons).
  def tool_dom_id(tool_call_id)
    "tool_" + tool_call_id.to_s.gsub(/[^A-Za-z0-9_-]/, "_")
  end
end
