# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "fileutils"

# Lean integration guard for the live monitor channel. Each case pins a path a
# plain HTTP curl cannot surface (WebSocket-only channel actions + the
# Turbo::StreamsChannel broadcasts the client `received` bridge renders): the
# Block/Section/Event model, per-tool progress policy (sh drops on finalize,
# llm_editor keeps), section open-by-state, message sectioning, and the
# append-vs-replace streaming semantics.
class MonitorChannelTest < ActionCable::Channel::TestCase
  def setup
    @tmp = Dir.mktmpdir("jobsdir")
    Rails.application.config.x.jobs_dir = @tmp
    job_dir = File.join(@tmp, "fakejob")
    FileUtils.mkdir_p(File.join(job_dir, "faketrial", "agent"))
    File.write(File.join(job_dir, "faketrial", "agent", "pi.txt"),
               %({"type":"turn_start"}\n))
  end

  def teardown
    FileUtils.remove_entry(@tmp) if @tmp && Dir.exist?(@tmp)
  end

  def append_trial_line(line)
    File.write(File.join(@tmp, "fakejob", "faketrial", "agent", "pi.txt"), line + "\n", mode: "a")
  end

  def trial_broadcasts
    broadcasts("monitor:fakejob:faketrial").map { |p| JSON.parse(p.to_s) }
  end

  test "subscribes to job + trial streams" do
    subscribe job: "fakejob", trial: "faketrial"
    assert subscription.confirmed?
    assert_has_stream "monitor:fakejob"
    assert_has_stream "monitor:fakejob:faketrial"
  end

  test "tick broadcasts stats on trial summary change" do
    subscribe job: "fakejob", trial: "faketrial"
    tdir = File.join(@tmp, "fakejob", "some-task__t1")
    FileUtils.mkdir_p(File.join(tdir, "agent"))
    File.write(File.join(tdir, "agent", "pi.txt"), %({"type":"turn_start"}\n))
    File.write(File.join(tdir, "result.json"),
               { "task_name" => "terminal-bench/some-task", "finished_at" => "2026-01-01T00:00:00Z", "verifier_result" => { "rewards" => { "reward" => 1.0 } } }.to_json)
    10.times { perform :tick } # push_stats runs every SORT_EVERY (10th) tick
    msgs = broadcasts("monitor:fakejob")
    assert_operator msgs.size, :>=, 1
    assert_match(/turbo-stream/, msgs.first.to_s)
    assert_match(%r{1/1 success}, msgs.first.to_s)
  end

  # sh tool: streaming shows an OPEN progress section; finalize DROPS progress
  # (the result already carries the full output) and collapses every section.
  # update/end REPLACE the block keyed by toolCallId (not append).
  test "sh tool drops progress on finalize and replaces in place" do
    subscribe job: "fakejob", trial: "faketrial"
    append_trial_line '{"type":"tool_execution_start","toolCallId":"functions.sh:0","toolName":"sh","args":{"command":"ls"}}'
    append_trial_line '{"type":"tool_execution_update","toolCallId":"functions.sh:0","toolName":"sh","args":{"command":"ls"},"partialResult":{"content":[{"type":"text","text":"partial"}]}}'
    append_trial_line '{"type":"tool_execution_end","toolCallId":"functions.sh:0","toolName":"sh","result":{"content":[{"type":"text","text":"done"}],"details":{"exitCode":0,"status":"completed"}},"isError":false}'
    perform :tick
    msgs = trial_broadcasts
    assert msgs.any? { |m| m.include?("p-transcript") && m.include?("append") },
           "expected tool_execution_start to append to #p-transcript"
    replaced = msgs.select { |m| m.include?("replace") && m.include?("tool_functions_sh_0") }
    assert_operator replaced.size, :>=, 2, "expected update + end to REPLACE the tool block"
    streaming, finalized = replaced.first, replaced.last
    assert streaming.match?(/sec progress" open/), "streaming tool shows an open progress section"
    assert streaming.include?("partial"), "streaming progress carries the partial result"
    assert finalized.include?("sec title"), "finalized tool keeps a title (invoke) section"
    assert finalized.include?("sec result"), "finalized tool keeps a result section"
    refute finalized.include?("sec progress"), "sh drops progress on finalize"
    refute finalized.include?("partial"), "sh progress content gone on finalize"
    assert finalized.include?("command"), "finalized tool carries the initiation args"
    refute finalized.match?(/ open>/), "finalized tool sections are collapsed"
  end

  # llm_editor opts into keeping progress on finalize (subagent transcript).
  test "llm_editor keeps progress on finalize" do
    subscribe job: "fakejob", trial: "faketrial"
    append_trial_line '{"type":"tool_execution_start","toolCallId":"functions.llm_editor:0","toolName":"llm_editor","args":{"command":"edit","path":"/x"}}'
    append_trial_line '{"type":"tool_execution_update","toolCallId":"functions.llm_editor:0","toolName":"llm_editor","args":{"command":"edit","path":"/x"},"partialResult":{"content":[{"type":"text","text":"<llm_editor_result>…</llm_editor_result>"}]}}'
    append_trial_line '{"type":"tool_execution_end","toolCallId":"functions.llm_editor:0","toolName":"llm_editor","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}'
    perform :tick
    finalized = trial_broadcasts.select { |m| m.include?("replace") && m.include?("tool_functions_llm_editor_0") }.last
    assert finalized, "expected a finalized llm_editor block"
    assert finalized.include?("sec progress"), "llm_editor keeps progress on finalize"
    assert finalized.include?("llm_editor_result"), "progress content retained"
  end

  # message block: thinking collapsed, text expanded; toolCall content skipped.
  test "message block sections thinking-collapsed text-expanded" do
    subscribe job: "fakejob", trial: "faketrial"
    append_trial_line '{"type":"message_end","message":{"role":"assistant","timestamp":1782081442255,"content":[{"type":"thinking","thinking":"reasoning"},{"type":"text","text":"hello"},{"type":"toolCall","id":"functions.sh:0","name":"sh","arguments":{"command":"ls"}}]}}'
    perform :tick
    blk = trial_broadcasts.select { |m| m.include?("append") && m.include?("blk msg") }.first
    assert blk, "expected an appended message block"
    assert blk.include?("blk msg assistant"), "message block carries the role class"
    assert blk.include?("sec thinking"), "thinking is its own section"
    refute blk.match?(/sec thinking" open/), "thinking collapsed by default"
    assert blk.match?(/sec text" open/), "text expanded by default"
    refute blk.include?('"type":"toolCall"'), "toolCall content is not rendered in the message block"
  end

  # events render inline (no box) with T+Ns when a timestamp is known.
  test "lifecycle events render inline with T+Ns" do
    subscribe job: "fakejob", trial: "faketrial"
    append_trial_line '{"type":"agent_start"}'
    append_trial_line '{"type":"session","timestamp":"2026-01-01T00:00:00Z","cwd":"/app"}'
    perform :tick
    appends = trial_broadcasts.select { |m| m.include?("append") && m.include?("evt") }
    assert_operator appends.size, :>=, 2, "expected agent_start + session events appended"
    ev = appends.find { |m| m.include?("agent start") }
    assert ev, "expected the agent_start event"
    assert ev.include?('<div class="evt"'), "events render inline, no box"
    refute ev.include?("blk"), "an event is not a boxed block"
    sess = appends.find { |m| m.include?("session") }
    assert sess, "expected the session event"
    assert sess.include?("T+0s"), "session carries T+0s (it is the T0)"
    assert sess.include?("/app"), "session shows cwd"
  end
end