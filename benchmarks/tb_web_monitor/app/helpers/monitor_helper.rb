# frozen_string_literal: true

# View helpers porting app.tsx formatting + Stats + grouping logic, so ERB
# can render a logically-identical DOM to the SolidJS app.
require "rexml/document"
require "rexml/formatters/pretty"
require "redcarpet"

module MonitorHelper
  MARKDOWN = Redcarpet::Markdown.new(Redcarpet::Render::HTML.new(filter_html: true), autolink: true, fenced_code_blocks: true, no_intra_emphasis: true, tables: true, strikethrough: true)
  # fmt(): K/M suffix like the SolidJS fmt; "—" for nil.
  def fmt(n)
    return "—" if n.nil?
    if n >= 1_000_000
      "#{format('%.1f', n.to_f / 1_000_000)}M"
    elsif n >= 1_000
      "#{format('%.1f', n.to_f / 1_000)}K"
    else
      n.to_i.to_s
    end
  end

  def fmt_dur(s)
    return "—" if s.nil?
    s = s.to_i
    "#{s / 60}m#{(s % 60).to_s.rjust(2, '0')}s"
  end

  def reward_bg(r)
    v = [[0, r.to_f].max, 1].min
    "hsla(#{(120 * v).round}, 50%, 40%, 0.25)"
  end

  # Classify a trial into a score bucket — single source of truth shared by
  # the stats line and the badge. Harness errors (provider failover /
  # unresponsive API endpoint) are excluded from the score; timeouts/crashes
  # count as fail.
  def trial_bucket(t)
    if t.status == "running" then :running
    elsif t.failover then :harness_err
    elsif t.status == "errored" then :fail
    elsif t.status == "completed" && !t.reward.nil? && t.reward > 0 then :pass
    else :fail
    end
  end

  # trialBadge(): [css_class, label] — derives from trial_bucket.
  def trial_badge(t)
    case trial_bucket(t)
    when :pass        then ["b-pass", "pass"]
    when :harness_err then ["b-ep", "endpoint"]
    when :running     then ["b-run", "run"]
    else
      if t.status == "errored" then ["b-err", "ERR"]
      elsif t.status == "completed" then ["b-fail", "fail"]
      else ["b-to", "timeout"]
      end
    end
  end

  def badge_title(label)
    { "pass" => "solved", "fail" => "not solved",
      "timeout" => "hit time limit (genuine fail)",
      "endpoint" => "LLM endpoint failed mid-run (excluded from genuine)",
      "run" => "running", "ERR" => "crashed" }.fetch(label, "")
  end

  # Stats component output: "E Harness Errors (Does not count) | R running |
  # N/M success | Score=X% (pass / (pass + fail))" — derived purely from
  # trial summaries; harness errors excluded from the score denominator;
  # N=pass, M=pass+fail.
  def stats_text(trials)
    pass = 0; fail_ = 0; he = 0; run = 0
    trials.each do |t|
      case trial_bucket(t)
      when :pass        then pass += 1
      when :fail        then fail_ += 1
      when :harness_err then he += 1
      when :running     then run += 1
      end
    end
    denom = pass + fail_
    score = denom.positive? ? format("%.1f", pass.to_f / denom * 100) : "0.0"
    "#{he} Harness Errors (Does not count) | #{run} running | #{pass}/#{denom} success | Score=#{score}% (pass / (pass + fail))"
  end

  # grouped(): trials grouped by task base, ordered by last invoke (pi.txt
  # mtime) descending so tests with active trials float to the top; task name
  # asc is the tiebreak. Subs within a group are also most-recent-first.
  def grouped_trials(trials)
    m = {}
    trials.each { |t| (m[t.task.split("__")[0]] ||= []) << t }
    m.map { |task, subs| [task, subs.sort_by { |s| -last_active(s).to_i }] }
     .sort_by { |task, subs| [-subs.map { |s| last_active(s).to_i }.max, task] }
  end

  # Last invoke time for a trial = pi.txt mtime (appended per event); epoch for
  # trials with no transcript yet so they sort last.
  def last_active(t)
    t.mtime || Time.at(0)
  end

  # taskReward(): mean reward of completed subs with a reward, else nil.
  def task_reward(subs)
    done = subs.select { |s| s.status == "completed" && !s.reward.nil? }
    return nil if done.empty?
    done.sum { |s| s.reward.to_f } / done.size
  end

  # sub id: trial minus its first "__" segment, falling back to the trial name.
  def sub_label(trial)
    parts = trial.split("__")
    label = parts[1..].join("__")
    label.empty? ? trial : label
  end
end

  # --- transcript rendering: Block (boxed, sectioned) + Event (inline, T+Ns) ---
  # Block/Event units + section shape come from TranscriptBlock / BlockRegistry;
  # helpers below are thin view glue (css class, section dispatch, event labels).

  # Sections for a block (registry dispatch); title section is always first.
  def block_sections(block)
    BlockRegistry.sections(block)
  end

  # Block CSS class: kind + role / state / error.
  def blk_class(b)
    css = Source.block_css(b)
    return css if css
    case b.kind
    when :message  then "blk msg #{(b.event['message'] || {})['role']}"
    when :tool     then "blk tool #{b.state}#{' err' if b.state == :finalized && b.event['isError']}"
    when :verifier then "blk verifier"
    else "blk #{b.kind}"
    end
  end

  # wall-clock + T+ stamp for an Event, or "" when the timestamp is unknown.
  def stamp(ev)
    TranscriptBlock.stamp(ev.t_ms, ev.t0_ms).html_safe
  end

  # Human label for a lifecycle event (the raw type otherwise).
  def event_label(ev)
    { "turn_start" => "turn", "turn_end" => "turn end",
      "agent_start" => "agent start", "agent_end" => "agent end",
      "session" => "session" }.fetch(ev.type, ev.type)
  end

  # Extra inline detail (cwd for session; nothing otherwise).
  def event_detail(ev)
    return "".html_safe unless ev.type == "session"
    "· #{ERB::Util.html_escape(ev.event['cwd'].to_s)}".html_safe
  end

  # Render markdown text to safe HTML, optionally wrapped in a CSS class.
  def markdown(text, css_class: nil)
    return "".html_safe if text.to_s.blank?
    html = MonitorHelper::MARKDOWN.render(text.to_s)
    css_class ? tag.div(html.html_safe, class: css_class) : html.html_safe
  end

  # Render one content block verbatim — JSON/XML kept raw (comments visible),
  # no flattening. b is a String or a Hash {type: text|thinking|toolCall|raw}.
  def render_content_block(b, markdown: false)
    return "".html_safe if b.nil?
    case b
    when String then tag.pre(pretty_format(b))
    when Hash
      case b["type"]
      when "text"     then markdown ? markdown(b["text"].to_s, css_class: "md") : tag.pre(pretty_format(b["text"].to_s))
      when "thinking" then markdown ? markdown(b["thinking"].to_s, css_class: "md c-think") : tag.pre(b["thinking"].to_s, class: "c-think")
      when "raw"     then b["html"].to_s.html_safe
      when "toolCall"
        args = b["arguments"]
        body = args.is_a?(String) ? pretty_format(args) : JSON.pretty_generate(args || {})
        safe_join([
          tag.div("→ #{b['name']} #{b['id']}", class: "c-call-hdr"),
          tag.pre(body)
        ])
      else tag.pre(JSON.pretty_generate(b))
      end
    else tag.pre(b.inspect)
    end
  end

  # Pretty-print a text block: JSON -> indented JSON, XML -> indented XML
  # (comments preserved), else the raw string. For tool args/result/progress.
  def pretty_format(text)
    s = text.to_s
    return s if s.strip.empty?
    stripped = s.strip
    if stripped.start_with?("{", "[")
      parsed = JSON.parse(stripped) rescue nil
      return JSON.pretty_generate(parsed) if parsed
    end
    if stripped.match?(/\A<[\w!?]/)
      out = +""
      REXML::Formatters::Pretty.new(2).write(REXML::Document.new(stripped), out)
      return out
    end
    s
  rescue StandardError
    s
  end
