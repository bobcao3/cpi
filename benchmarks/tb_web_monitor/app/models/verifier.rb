# frozen_string_literal: true

# Port of server.ts readVerifier: reward.txt (trimmed) + test-stdout.txt.
module Verifier
  Result = Struct.new(:reward, :stdout, keyword_init: true)

  module_function

  def for(job, trial)
    dir = File.join(JobsDir.root, job, trial, "verifier")
    Result.new(
      reward: read(File.join(dir, "reward.txt"))&.strip,
      stdout: read(File.join(dir, "test-stdout.txt"))
    )
  end

  def read(path)
    File.read(path)
  rescue Errno::ENOENT
    nil
  end
end
