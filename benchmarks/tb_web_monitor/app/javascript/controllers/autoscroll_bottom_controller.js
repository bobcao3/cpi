import { Controller } from "@hotwired/stimulus"

// Pins a scrollable progress body to its bottom on connect. Tool blocks are
// REPLACED on each streaming update, so the progress <pre> is recreated fresh
// (scrolled to the top) every tick — this keeps the latest streamed output in
// view. Turbo streamed replaces carry no built-in scroll action; per the
// handbook, a Stimulus controller on the replaced element is the idiom (same
// pattern as autoscroll-item). Attached to the progress section's sec-body.
export default class extends Controller {
  connect() {
    const pre = this.element.querySelector("pre")
    if (pre) pre.scrollTop = pre.scrollHeight
  }
}
