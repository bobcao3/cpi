# frozen_string_literal: true

# Renders the TB2.1 monitor. URL-driven (like SolidJS writeQuery):
#   /                       -> pick newest job, no trial
#   /jobs/:job              -> job selected, no trial
#   /jobs/:job/trial/:trial -> job + trial selected (transcript backfilled)
class MonitorsController < ApplicationController
  layout "monitor"

  def index
    @selected = params[:trial].presence || ""
    if turbo_frame_request?
      @job = params[:job]
      @jobs = []
      @trials = []
      @trial_running = @job.present? && @selected.present? && TrialSummary.running?(@job, @selected)
    else
      @jobs = JobsDir.list_jobs
      @job = pick_job(@jobs, params[:job])
      @trials = @job ? TrialSummary.list(@job) : []
      @trial_running = @selected.present? && @trials.any? { |t| t.trial == @selected && t.status == "running" }
    end
    @transcript = (@job && @selected) ? Transcript.events(@job, @selected) : []
  end

  private

  def pick_job(jobs, preferred)
    return preferred if preferred && jobs.any? { |j| j.name == preferred }
    jobs.first&.name
  end
end
