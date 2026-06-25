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
    append_trial_line '{"type":"tool_execution_start","toolCallId":"functions.sh:0","toolName":"sh","args":{"command":"echo hello","description":"greet"}}'
    append_trial_line '{"type":"tool_execution_update","toolCallId":"functions.sh:0","toolName":"sh","args":{"command":"echo hello","description":"greet"},"partialResult":{"content":[{"type":"text","text":"partial"}]}}'
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
    assert finalized.include?("greet"), "cpi sh title carries the description"
    assert finalized.include?("echo hello"), "cpi sh body carries the command"
    refute finalized.include?('"command"'), "cpi sh does not dump raw JSON args"
    refute finalized.include?('"description"'), "cpi sh does not dump raw JSON args"
    refute finalized.match?(%r{<span class="status">}), "cpi sh title does not carry the status text (kept in result)"
    refute finalized.match?(%r{<span class="exit">}), "cpi sh title does not carry the exit text (kept in result)"
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
    append_trial_line '{"type":"session","timestamp":1782081382255,"cwd":"/app"}'
    append_trial_line '{"type":"message_end","message":{"role":"assistant","timestamp":1782081442255,"content":[{"type":"thinking","thinking":"reasoning"},{"type":"text","text":"**hello**"},{"type":"toolCall","id":"functions.sh:0","name":"sh","arguments":{"command":"ls"}}]}}'
    perform :tick
    blk = trial_broadcasts.select { |m| m.include?("append") && m.include?("blk msg") }.first
    assert blk, "expected an appended message block"
    assert blk.include?("blk msg assistant"), "message block carries the role class"
    assert blk.include?("T+1:00s"), "message title carries wall-clock + T+"
    assert blk.include?("sec thinking"), "thinking is its own section"
    refute blk.match?(/sec thinking" open/), "thinking collapsed by default"
    assert blk.include?("text-body"), "text body always expanded (no collapse)"
    assert blk.include?("<strong>hello</strong>"), "text body is rendered as Markdown"
    refute blk.match?(/sec text/), "text is not a collapsible section"
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
    assert sess.match?(/\d{2}:\d{2}:\d{2} · T\+00s/), "session carries wall-clock + T+0min:00s (it is the T0)"
    assert sess.include?("/app"), "session shows cwd"
  end

  test "cpi notification renders from details not raw XML" do
    subscribe job: "fakejob", trial: "faketrial"
    append_trial_line({
      "type" => "message_end",
      "message" => {
        "role" => "custom",
        "customType" => "notification",
        "content" => '<notification type="shell-complete"><summary>Shell 1 completed on exit 0</summary></notification>',
        "display" => true,
        "details" => {
          "kind" => "shell-complete",
          "summary" => "Shell 1 completed on exit 0",
          "payload" => { "shell-id" => "1", "exit-code" => 0, "summary" => "Shell 1 completed on exit 0" }
        },
        "timestamp" => 1782082598963
      }
    }.to_json)
    perform :tick
    blk = trial_broadcasts.select { |m| m.include?("append") && m.include?("blk notif") }.first
    assert blk, "expected an appended notification block"
    assert blk.include?("shell-complete"), "notification title carries the kind"
    assert blk.include?("Shell 1 completed on exit 0"), "notification title carries the summary"
    refute blk.include?("<notification"), "raw XML is not rendered"
    refute blk.match?(/class="blk msg/), "notification is not a plain message block"
  end

  test "cpi wait_any renders as unexpandable title with parsed call timestamp" do
    subscribe job: "fakejob", trial: "faketrial"
    t0 = 1782082508963
    append_trial_line %({"type":"session","timestamp":#{t0},"cwd":"/app"})
    ts = 1782082598963
    append_trial_line({
      "type" => "tool_execution_start",
      "toolCallId" => "call_w1",
      "toolName" => "wait_any",
      "args" => {}
    }.to_json)
    append_trial_line({
      "type" => "tool_execution_end",
      "toolCallId" => "call_w1",
      "toolName" => "wait_any",
      "isError" => false,
      "result" => { "content" => [{ "type" => "text", "text" => "" }], "terminate" => true, "timestamp" => ts }
    }.to_json)
    perform :tick
    finalized = trial_broadcasts.select { |m| m.include?("replace") && m.include?("call_w1") }.last
    assert finalized, "expected a finalized wait_any block"
    assert finalized.match?(/sec title static/), "unexpandable title, no body"
    refute finalized.include?("sec result"), "result not dumped as a section"
    refute finalized.include?("sec progress"), "no progress section"
    assert finalized.include?(TranscriptBlock.stamp(ts, t0)), "call timestamp shows wall-clock + T+"
  end

  test "cpi llm_editor edit result renders diff red/green with dimmed line numbers" do
    subscribe job: "fakejob", trial: "faketrial"
    xml = "<llm_editor_result><id>abc</id><command>edit</command><path>/app/foo.py</path><blocks>1</blocks><rewrite>false</rewrite><match>exact</match><diff>  1 import os\n-  2 import sys\n+  2 import re</diff></llm_editor_result>"
    append_trial_line({
      "type" => "tool_execution_end",
      "toolCallId" => "call_le1",
      "toolName" => "llm_editor",
      "isError" => false,
      "result" => { "content" => [{ "type" => "text", "text" => xml }] }
    }.to_json)
    perform :tick
    finalized = trial_broadcasts.select { |m| m.include?("replace") && m.include?("call_le1") }.last
    assert finalized, "expected a finalized llm_editor edit block"
    assert finalized.include?("le diff"), "diff pre rendered"
    assert finalized.include?("dl add"), "added green"
    assert finalized.include?("dl del"), "removed red"
    assert finalized.include?("dl ctx"), "context"
    assert finalized.include?('class="ln"'), "line numbers rendered"
    assert finalized.include?("/app/foo.py"), "path in header"
    refute finalized.include?("<llm_editor_result>"), "raw XML parsed away, not dumped"
  end

  # split tools: cpi now exposes read/write/edit (tool name IS the command),
  # overriding the builtins. New transcripts carry <editor_result> XML (still
  # with a <command> field); legacy transcripts used a single `llm_editor` tool.
  test "new split `edit` tool call renders and parses <editor_result>" do
    subscribe job: "fakejob", trial: "faketrial"
    xml = "<editor_result><id>abc</id><command>edit</command><path>/app/foo.py</path><blocks>1</blocks><rewrite>false</rewrite><match>exact</match><diff>  1 import os\n-  2 import sys\n+  2 import re</diff></editor_result>"
    append_trial_line({
      "type" => "tool_execution_end",
      "toolCallId" => "functions.edit:0",
      "toolName" => "edit",
      "isError" => false,
      "result" => { "content" => [{ "type" => "text", "text" => xml }] }
    }.to_json)
    perform :tick
    finalized = trial_broadcasts.select { |m| m.include?("replace") && m.include?("tool_functions_edit_0") }.last
    assert finalized, "expected a finalized edit block under the new split name"
    assert finalized.include?(%(<span class="tname">edit</span>)), "title shows the new tool name"
    assert finalized.include?("le diff"), "diff pre rendered"
    assert finalized.include?("dl add"), "added green"
    assert finalized.include?("dl del"), "removed red"
    assert finalized.include?("/app/foo.py"), "path in header"
    refute finalized.include?("<editor_result>"), "raw XML parsed away, not dumped"
  end

  test "new split `read` tool call renders view content" do
    subscribe job: "fakejob", trial: "faketrial"
    xml = "<editor_result><id>abc</id><command>read</command><path>/app/foo.py</path><content>  1\timport os\n  2\timport sys</content></editor_result>"
    append_trial_line({
      "type" => "tool_execution_end",
      "toolCallId" => "functions.read:0",
      "toolName" => "read",
      "isError" => false,
      "result" => { "content" => [{ "type" => "text", "text" => xml }] }
    }.to_json)
    perform :tick
    finalized = trial_broadcasts.select { |m| m.include?("replace") && m.include?("tool_functions_read_0") }.last
    assert finalized, "expected a finalized read block under the new split name"
    assert finalized.include?(%(<span class="tname">read</span>)), "title shows the new tool name"
    assert finalized.include?("import os"), "view content rendered"
    assert finalized.include?("/app/foo.py"), "path in header"
    refute finalized.include?("<editor_result>"), "raw XML parsed away, not dumped"
  end

  test "verdict is broadcast when available and stays last after new transcript events" do
    subscribe job: "fakejob", trial: "faketrial"

    # transcript event without verifier yet
    append_trial_line '{"type":"message_end","message":{"role":"assistant","timestamp":1782081382255,"content":[{"type":"text","text":"before verdict"}]}}'
    perform :tick
    msgs = trial_broadcasts
    assert msgs.any? { |m| m.to_s.include?("before verdict") }, "message broadcast before verifier exists"
    refute msgs.any? { |m| m.to_s.include?("blk verifier") }, "no verifier broadcast yet"

    # verifier result becomes available
    verifier_dir = File.join(@tmp, "fakejob", "faketrial", "verifier")
    FileUtils.mkdir_p(verifier_dir)
    File.write(File.join(verifier_dir, "reward.txt"), "1.0\n")

    before = trial_broadcasts.size
    perform :tick
    new_msgs = trial_broadcasts[before..]
    assert new_msgs.last.to_s.include?("blk verifier"), "verdict append is the last broadcast when it appears"

    # another transcript event arrives after the verdict
    append_trial_line '{"type":"message_end","message":{"role":"assistant","timestamp":1782081442255,"content":[{"type":"text","text":"after verdict"}]}}'
    before = trial_broadcasts.size
    perform :tick
    new_msgs = trial_broadcasts[before..]
    msg_idx = new_msgs.find_index { |m| m.to_s.include?("after verdict") }
    verdict_idx = new_msgs.find_index { |m| m.to_s.include?("blk verifier") }
    assert msg_idx, "new message broadcast after verdict"
    assert verdict_idx, "verdict re-broadcast after new message"
    assert_operator verdict_idx, :>, msg_idx, "verdict stays after new transcript events"
  end
end
