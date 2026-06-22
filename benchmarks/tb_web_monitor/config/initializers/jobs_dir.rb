# frozen_string_literal: true

# Filesystem root for harbor job outputs (shared with the Bun monitor).
# Override with the JOBS_DIR env var.
default = File.expand_path("../../../terminal_bench_2_1/jobs", __dir__)
Rails.application.config.x.jobs_dir = File.expand_path(ENV.fetch("JOBS_DIR", default))
