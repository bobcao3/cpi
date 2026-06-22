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
    r = JobsDir.read_json(File.join(JobsDir.root, job, name, "result.json"))
    reward = r&.dig("verifier_result", "rewards", "reward")

    status =
      if !reward.nil? then "completed"
      elsif r&.[]("exception_info") then "errored"
      elsif r&.[]("finished_at") then "completed"
      else "running"
      end

    mtime = File.mtime(File.join(JobsDir.root, job, name, "agent", "pi.txt")) rescue nil

    Trial.new(
      name,
      (r&.[]("task_name") || name).to_s.sub(/^terminal-bench\//, ""),
      status,
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

  # Cheapest single-trial running check (no mtime/failover scan): mirrors the
  # status branch of #summarize. Used by frame visits that skip TrialSummary.list
  # (the trials panel is not re-rendered, so only the selected trial matters).
  def running?(job, trial)
    r = JobsDir.read_json(File.join(JobsDir.root, job, trial, "result.json"))
    r&.dig("verifier_result", "rewards", "reward").nil? &&
      !r&.[]("exception_info") &&
      !r&.[]("finished_at")
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

    f = detect_failover(File.join(JobsDir.root, job, name, "agent", "pi.txt"))
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
