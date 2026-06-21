import { Controller } from "@hotwired/stimulus"

// Per-block insertion trigger: on connect (append or replace), delegate to the
// pane's autoscroll controller, which scrolls to the bottom only if the user
// is at the bottom (disengaged on scroll-up). This is the handbook's idiom —
// the appended element carries a controller whose connect() fires on insertion.
export default class extends Controller {
  connect() {
    const pane = this.element.closest("[data-controller~='autoscroll']")
    const ctrl = pane && this.application.getControllerForElementAndIdentifier(pane, "autoscroll")
    ctrl?.itemAdded()
  }
}
