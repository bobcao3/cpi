# frozen_string_literal: true

# Transcript source dispatch. A "source" is the agent harness that produced a
# transcript — cpi, plain pi, … — and may specialize how tool blocks and custom
# messages render. Each source is a module responding to tool_sections /
# message_sections / block_css, returning a value (Sections Array / css String)
# when it owns the block, or nil to fall through to the generic BlockRegistry
# handler.
#
# Detection is per-block from self-contained event signals (cpi's `sh` tool name,
# cpi's `notification` custom messages), so a block renders identically whether
# rebuilt from a full snapshot or a live single-event delta — no transcript-wide
# source pass or state threading. Sources are tried in order; first non-nil wins.
# Add a source by appending its module to SOURCES.
module Source
  SOURCES = [Sources::Cpi].freeze

  module_function

  def tool_sections(block)
    SOURCES.each { |s| v = s.tool_sections(block); return v unless v.nil? }
    nil
  end

  def message_sections(block)
    SOURCES.each { |s| v = s.message_sections(block); return v unless v.nil? }
    nil
  end

  def block_css(block)
    SOURCES.each { |s| v = s.block_css(block); return v unless v.nil? }
    nil
  end
end
