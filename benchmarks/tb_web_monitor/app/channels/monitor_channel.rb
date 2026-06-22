# frozen_string_literal: true

# Live monitor over ActionCable + Turbo Streams.
#
# One subscription per page-load, parameterised with the current job (+trial).
# Streams:
#   monitor:{job}           -> trials / stats / log   (job-wide, update/append)
#   monitor:{job}:{trial}   -> transcript             (trial-specific, append)
#
# The page is server-rendered with a snapshot; on subscribe the offsets and
# signatures are seeded to the current end-of-file so only DELTAS are pushed.
# The channel polls the filesystem on a fixed 1s interval (`periodically`).
class MonitorChannel < ApplicationCable::Channel
  PERIOD = 1.second
  # Trials panel (sort + stats header) re-broadcasts at most every SORT_EVERY
  # ticks (10s) so active runs don't reshuffle every second; transcript stays 1s.
  SORT_EVERY = 10

  # Fires per-instance after subscription (instance_exec'd block).
  periodically every: PERIOD do
    tick
  end

  def subscribed
    @job = params[:job]
    @trial = params[:trial].presence

    if @job.blank?
      reject
      return
    end

    stream_from "monitor:#{@job}"
    stream_from "monitor:#{@job}:#{@trial}" if @trial

    @t_sig = trials_sig
    @t_off = @trial ? Transcript.size(@job, @trial) : 0

    @tool_args = {}
    @tool_partial = {}
    @tool_updates = {}
    if @trial
      events = Transcript.events(@job, @trial)
      @t0 = TranscriptBlock.session_t0(events)
      events.each do |ev|
        id = ev["toolCallId"]
        next unless id
        @tool_args[id] ||= ev["args"] if ev["args"]
        @tool_partial[id] = ev["partialResult"] if ev["partialResult"]
        @tool_updates[id] = (@tool_updates[id] || 0) + 1 if ev["type"] == "tool_execution_update"
      end
    else
      @t0 = nil
    end

    @v_sig = verifier_sig
  end

  # Public so the periodically timer (instance_exec'd block) can call it.
  def tick
    @ticks = (@ticks || 0) + 1
    push_transcript
    push_verdict
    push_stats if @ticks % SORT_EVERY == 0
  end

  private

  # Replace #stats + #tbody together when the trial summary changes (sig compare).
  def push_stats
    trials = TrialSummary.list(@job)
    return if trials.to_json == @t_sig

    @t_sig = trials.to_json
    Turbo::StreamsChannel.broadcast_update_to("monitor:#{@job}", target: "stats",
                                               partial: "monitors/stats",
                                               locals: { trials: trials })
    Turbo::StreamsChannel.broadcast_update_to("monitor:#{@job}", target: "tbody",
                                               partial: "monitors/trial_rows",
                                               locals: { trials: trials, selected: @trial })
  end

  def push_transcript
    return unless @trial
    events, @t_off = Transcript.since(@job, @trial, @t_off)
    @transcript_broadcast = false
    events.each do |ev|
      t = ev["type"]
      id = ev["toolCallId"]
      @tool_args[id] ||= ev["args"] if id && ev["args"]
      @tool_partial[id] = ev["partialResult"] if id && ev["partialResult"]
      @tool_updates[id] = (@tool_updates[id] || 0) + 1 if id && t == "tool_execution_update"
      case t
      when "tool_execution_update", "tool_execution_end"
        @transcript_broadcast = true
        broadcast_block(:replace, TranscriptBlock::Block.new(
          kind: :tool, id: Transcript.tool_dom_id(id),
          state: (t == "tool_execution_end" ? :finalized : :streaming),
          tool_name: ev["toolName"], event: ev, args: @tool_args[id],
          partial: @tool_partial[id], updates: @tool_updates[id] || 0, t0_ms: @t0))
      when "message_start", "message_update"
        next
      when "tool_execution_start"
        @transcript_broadcast = true
        broadcast_block(:append, TranscriptBlock::Block.new(
          kind: :tool, id: Transcript.tool_dom_id(id), state: :streaming,
          tool_name: ev["toolName"], event: ev, args: @tool_args[id],
          partial: @tool_partial[id], updates: 0, t0_ms: @t0))
      when "message_end"
        next if (ev["message"] || {})["role"] == "toolResult"
        @transcript_broadcast = true
        broadcast_block(:append, TranscriptBlock::Block.new(kind: :message, state: :finalized, event: ev, t0_ms: @t0))
      else
        @t0 = TranscriptBlock.ts_to_ms(ev["timestamp"] || ev["ts"]) if t == "session" && @t0.nil?
        @transcript_broadcast = true
        Turbo::StreamsChannel.broadcast_append_to("monitor:#{@job}:#{@trial}",
          target: "p-transcript", partial: "monitors/event",
          locals: { event: TranscriptBlock::Event.new(type: t,
                  t_ms: TranscriptBlock.ts_to_ms(ev["timestamp"] || ev["ts"]), t0_ms: @t0, event: ev) })
      end
    end
  end

  def push_verdict
    return unless @trial

    sig = verifier_sig
    return if sig == @v_sig && !@transcript_broadcast

    @v_sig = sig
    return if sig.nil?

    blk = TranscriptBlock.verifier_block(Verifier.for(@job, @trial))
    Turbo::StreamsChannel.broadcast_remove_to("monitor:#{@job}:#{@trial}", target: blk.id)
    Turbo::StreamsChannel.broadcast_append_to("monitor:#{@job}:#{@trial}", target: "p-transcript",
      partial: "monitors/block", locals: { block: blk })
  end

  # Broadcast a Block: replace an existing tool block in place (update/end), or
  # append a new block to the transcript pane (start/message).
  def broadcast_block(mode, blk)
    if mode == :replace
      Turbo::StreamsChannel.broadcast_replace_to("monitor:#{@job}:#{@trial}", target: blk.id,
        partial: "monitors/block", locals: { block: blk })
    else
      Turbo::StreamsChannel.broadcast_append_to("monitor:#{@job}:#{@trial}", target: "p-transcript",
        partial: "monitors/block", locals: { block: blk })
    end
  end


  def trials_sig
    TrialSummary.list(@job).to_json
  end

  def verifier_sig
    v = Verifier.for(@job, @trial)
    return nil if v.reward.nil? && v.stdout.nil?

    v.to_json
  end
end
