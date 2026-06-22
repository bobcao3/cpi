# frozen_string_literal: true

# Harbor's per-job command log (job.log) records every shell command run inside
# task containers. The container startup = the setup commands (environment +
# agent setup) that run BEFORE the agent; the per-task `pi --print` invocations
# ARE the agent run (they produce agent/pi.txt, already the transcript) and are
# excluded. Setup is identical across trials, but harbor interleaves N
# concurrent trials, so the raw log repeats each command N times — dedup globally
# by command (first-seen order) to recover the one startup recipe. "Command
# outputs captured" is harbor's no-output marker (output went to /logs/...) and
# is dropped. Bounded for safety (TigerStyle: put a limit on everything).
module ContainerLog
  MAX_BYTES = 64_000
  CMD_PREFIX = "Running command: "
  AGENT_RUN = "pi --print" # cpi agent invocation -> the transcript itself

  module_function

  def startup(job)
    path = JobsDir.job_log_path(job)
    return nil unless File.exist?(path)

    text = File.binread(path).force_encoding("UTF-8")
    recipes = parse_records(text).reject { |r| r.first.include?(AGENT_RUN) }
    seen = {}
    recipes.each { |r| seen[r.first] ||= r }
    out = seen.values.map { |r| r.join("\n") }.join("\n\n")
    return nil if out.empty?
    out.bytesize > MAX_BYTES ? "#{out.byteslice(0, MAX_BYTES)}\n… (truncated)" : out
  end

  # Split job.log into "Running command:" records: the command line plus every
  # line up to (excluding) the next command line — heredoc bodies stay attached
  # to their command. Trailing "Command outputs captured" / blank lines dropped.
  def parse_records(text)
    records = []
    cur = nil
    text.split("\n", -1).each do |ln|
      if ln.start_with?(CMD_PREFIX)
        cur = [ln]
        records << cur
      elsif cur
        cur << ln
      end
    end
    records.each do |r|
      r.pop while r.size > 1 && (r.last == "Command outputs captured" || r.last.strip.empty?)
    end
    records.reject(&:empty?)
  end
end
