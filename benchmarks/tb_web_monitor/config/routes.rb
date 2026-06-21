Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check
  mount ActionCable.server => "/cable"

  root "monitors#index"
  get "/jobs/:job/trial/:trial", to: "monitors#index", as: :job_trial
  get "/jobs/:job", to: "monitors#index", as: :job
end
