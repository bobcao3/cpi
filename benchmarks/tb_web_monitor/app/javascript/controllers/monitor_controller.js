import { Controller } from "@hotwired/stimulus"
import { createConsumer } from "@rails/actioncable"

// Monitor controller: job/trial navigation, layout, and the live ActionCable
// connection. One consumer is shared across Turbo Drive navigations (module
// singleton); a subscription is created on connect and torn down on disconnect.
const consumer = createConsumer()

export default class extends Controller {
  static targets = ["jobSel", "trials", "wsdot"]

  connect() {
    this.layout()
    this.subscribe()
  }

  disconnect() {
    this.subscription?.unsubscribe()
    this.subscription = null
  }

  // Keep `main` height in sync with the header (CSS var --header-h).
  layout() {
    const h = this.element.querySelector("header")?.getBoundingClientRect().height ?? 0
    document.body.style.setProperty("--header-h", `${h}px`)
  }

  // Subscribe to the MonitorChannel for the current job + trial. The page
  // already holds the snapshot; the channel pushes deltas, and `received`
  // feeds each Turbo Stream into Turbo so it is applied to the DOM.
  subscribe() {
    const job = this.element.dataset.monitorJob
    const trial = this.element.dataset.monitorTrial || ""
    if (!job) return
    this.setDot("connecting")
    this.subscription = consumer.subscriptions.create(
      { channel: "MonitorChannel", job, trial },
      {
        connected: () => this.setDot("live"),
        disconnected: () => this.setDot("dead"),
        rejected: () => this.setDot("dead"),
        received: (data) => Turbo.renderStreamMessage(data)
      }
    )
  }

  setDot(state) {
    this.wsdotTarget.className = state
  }

  // Changing jobs is a full Turbo Drive visit (new job = fresh everything).
  changeJob() {
    const job = this.jobSelTarget.value
    Turbo.visit(job ? `/jobs/${encodeURIComponent(job)}` : "/")
  }

  // Selecting a trial is a full Turbo Drive visit. The URL encodes job + trial
  // so a refresh restores the exact view; the cable reconnects per visit,
  // seeding the new trial's offset from its snapshot.
  selectTrial(event) {
    const tr = event.target.closest("tr[data-trial]")
    if (!tr) return
    Turbo.visit(`/jobs/${encodeURIComponent(this.jobSelTarget.value)}/trial/${encodeURIComponent(tr.dataset.trial)}`)
  }
}
