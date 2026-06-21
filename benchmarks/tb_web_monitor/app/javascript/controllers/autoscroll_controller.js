import { Controller } from "@hotwired/stimulus"

// Auto-scrolls a scrollable pane to the bottom ONLY while a run is live, then
// preserves the user's scroll position once it completes. `running` (a Stimulus
// value) drives engagement:
//   running=true  -> appended blocks scroll to the bottom (only if the user is
//                    at the bottom; scrolling up disengages, scrolling back
//                    re-engages). Tab activation jumps to the bottom.
//   running=false -> no auto-scroll; scroll is preserved across morph refreshes
//                    by stable-id node retention + turbo-refresh-scroll=preserve.
//
// Per the Turbo handbook (Streams + scroll): streamed appends carry no built-in
// scroll action — "additional behavior should attach via Stimulus controllers."
// The appended element's connect() (autoscroll-item) is the insertion trigger;
// this controller is the running-gate + atBottom owner + scroll actor.
export default class extends Controller {
  static values = { running: Boolean }

  connect() {
    this.atBottom = true
    this.onScroll = this.onScroll.bind(this)
    this.element.addEventListener("scroll", this.onScroll)
    if (this.runningValue) this.scrollToBottom()
  }

  disconnect() {
    this.element.removeEventListener("scroll", this.onScroll)
  }

  onScroll() {
    const el = this.element
    this.atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
  }

  // Called by autoscroll-item on each appended/replaced block.
  itemAdded() {
    if (this.runningValue && this.atBottom) this.scrollToBottom()
  }

  // Called by tabs_controller when this pane becomes visible.
  activate() {
    if (this.runningValue) this.scrollToBottom()
  }

  // Running state flipped mid-session (e.g. trial/job completed, applied via a
  // morph refresh that updates data-autoscroll-running-value): stop following
  // when it goes false; resume at the bottom if it (re)goes true.
  runningValueChanged(value) {
    if (value && this.atBottom) this.scrollToBottom()
  }

  scrollToBottom() {
    this.element.scrollTop = this.element.scrollHeight
    this.atBottom = true
  }
}
