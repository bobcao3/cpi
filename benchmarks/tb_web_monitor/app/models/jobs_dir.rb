# frozen_string_literal: true

# Filesystem access to harbor job outputs (shared with the Bun monitor).
# All paths resolve under Rails.application.config.x.jobs_dir (see
# config/initializers/jobs_dir.rb); override at runtime with JOBS_DIR=.
module JobsDir
  Job = Struct.new(:name, :mtime)

  module_function

  def root
    Rails.application.config.x.jobs_dir
  end

  def job_result(job)
    read_json(File.join(root, job, "result.json"))
  end

  def transcript_path(job, trial)
    File.join(root, job, trial, "agent", "pi.txt")
  end


  # Jobs = immediate subdirs of root, newest first (mtime desc).
  def list_jobs
    Dir.children(root)
       .select { |n| File.directory?(File.join(root, n)) }
       .map { |n| Job.new(n, (File.mtime(File.join(root, n)).to_f * 1000).to_i) }
       .sort_by { |j| -j.mtime }
  rescue Errno::ENOENT
    []
  end

  def read_json(path)
    JSON.parse(File.read(path))
  rescue Errno::ENOENT, JSON::ParserError
    nil
  end
end
