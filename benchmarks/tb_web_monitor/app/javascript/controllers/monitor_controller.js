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
    this.onFrameLoad = (event) => this.detailLoaded(event)
    document.addEventListener("turbo:frame-load", this.onFrameLoad)
  }

  disconnect() {
    this.subscription?.unsubscribe()
    this.subscription = null
    document.removeEventListener("turbo:frame-load", this.onFrameLoad)
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

  // Selecting a trial swaps only the #detail frame (the transcript pane), so the
  // trials panel — and its scroll position — is left untouched. data-turbo-action
  // on the frame advances the URL so a refresh restores the exact trial. The body
  // (and this controller) are not re-rendered on a frame visit, so the cable
  // subscription would stay on the OLD trial — detailLoaded re-seeds it. The sel
  // highlight is moved by hand since #trials is not re-rendered either.
  selectTrial(event) {
    const tr = event.target.closest("tr[data-trial]")
    if (!tr || tr.classList.contains("sel")) return
    this.trialsTarget.querySelector("tr.sel")?.classList.remove("sel")
    tr.classList.add("sel")
    Turbo.visit(`/jobs/${encodeURIComponent(this.jobSelTarget.value)}/trial/${encodeURIComponent(tr.dataset.trial)}`, { frame: "detail" })
  }

  // turbo:frame-load on #detail: the frame swapped to a new trial. A frame visit
  // does not cycle this controller, so re-seed the cable subscription to the
  // newly shown trial. The trial is read from the swapped #p-transcript child
  // (always fresh) rather than the frame element, whose attributes Turbo may not
  // replace when it swaps only the frame's content.
  detailLoaded(event) {
    const frame = event.target
    if (frame.id !== "detail") return
    const trial = frame.querySelector("#p-transcript")?.dataset.trial || ""
    if (trial === this.element.dataset.monitorTrial) return
    this.element.dataset.monitorTrial = trial
    this.subscription?.unsubscribe()
    this.subscribe()
  }
}
