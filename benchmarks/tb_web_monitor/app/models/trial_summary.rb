# frozen_string_literal: true

require "time"

# Port of server.ts listTrials(): summarize every trial dir under a job.
# A "trial" dir name contains "__"; each holds a result.json written by harbor.
module TrialSummary
  Trial = Struct.new(:trial, :task, :status, :reward, :in_tokens, :out_tokens,
                      :cost_usd, :duration_s, :error, :finished, :failover, :mtime)

  @failover_cache = {} # "job/trial" => bool, only finished trials cached

  module_function

  def list(job)
    job_path = File.join(JobsDir.root, job)
    Dir.children(job_path)
       .select { |n| n.include?("__") && File.directory?(File.join(job_path, n)) }
       .map { |name| summarize(job, name) }
       .sort_by(&:task)
  rescue Errno::ENOENT
    []
  end

  def summarize(job, name)
    r = JobsDir.read_json(JobsDir.trial_result(job, name))
    reward = r&.dig("verifier_result", "rewards", "reward")

    mtime = File.mtime(JobsDir.transcript_path(job, name)) rescue nil

    Trial.new(
      name,
      (r&.[]("task_name") || name).to_s.sub(/^terminal-bench\//, ""),
      status_for(reward, r),
      reward,
      r&.dig("agent_result", "n_input_tokens"),
      r&.dig("agent_result", "n_output_tokens"),
      r&.dig("agent_result", "cost_usd"),
      duration_s(r),
      error_str(r),
      r&.[]("finished_at"),
      failover?(job, name, r),
      mtime
    )
  end

  # Cheapest single-trial running check (no mtime/failover scan): delegates to
  # #status_for so it can't drift from #summarize. Used by frame visits that skip
  # TrialSummary.list (the trials panel is not re-rendered, so only the selected
  # trial matters).
  def running?(job, trial)
    r = JobsDir.read_json(JobsDir.trial_result(job, trial))
    status_for(r&.dig("verifier_result", "rewards", "reward"), r) == "running"
  end

  # Single source of truth for a trial's status from its result.json. Order
  # matters: a reward (incl. 0.0, a genuine fail) -> completed; an exception
  # -> errored; otherwise finished_at -> completed, else running. Both
  # #summarize (full Trial struct) and #running? (cheap bool) go through here
  # so the precedence cannot drift between the two call paths.
  def status_for(reward, r)
    return "completed" if !reward.nil?
    return "errored"    if r&.[]("exception_info")
    return "completed" if r&.[]("finished_at")
    "running"
  end

  def duration_s(r)
    return nil unless r&.[]("started_at") && r&.[]("finished_at")
    (Time.iso8601(r["finished_at"]) - Time.iso8601(r["started_at"])).round
  end

  # Port of server.ts fmtError (inlined).
  def error_str(r)
    ei = r&.[]("exception_info")
    return nil if ei.nil?
    return ei.slice(0, 500) if ei.is_a?(String)

    t = ei["exception_type"] ? ei["exception_type"].to_s : ""
    m = ei["exception_message"] ? ei["exception_message"].to_s : ""
    s = t.empty? ? (m.empty? ? ei.to_json : m) : (m.empty? ? t : "#{t}: #{m}")
    s.slice(0, 500)
  end

  # Port of server.ts trialFailover (inlined): scan the tail of agent/pi.txt.
  def failover?(job, name, r)
    key = "#{job}/#{name}"
    finished = !r&.[]("finished_at").nil?
    return @failover_cache[key] if finished && @failover_cache.key?(key)

    f = detect_failover(JobsDir.transcript_path(job, name))
    @failover_cache[key] = f if finished
    f
  end

  def detect_failover(path)
    size = File.size?(path).to_i
    return false if size.zero?
    tail = if size > 32768
             File.open(path, "rb") { |fh| fh.seek(size - 32768); fh.read(32768) }
    else
             File.binread(path)
    end
    text = tail.force_encoding("UTF-8")
    text.include?("provider-failover") || text.include?("no fallback candidate")
  rescue Errno::ENOENT
    false
  end
end
