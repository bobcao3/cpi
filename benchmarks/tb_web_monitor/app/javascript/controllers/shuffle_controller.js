import { Controller } from "@hotwired/stimulus"

// FLIP-animated reshuffle of the trials panel. When the channel re-sorts #tbody
// (a Turbo Stream `update`), snapshot each row's vertical position (First), let
// Turbo apply the new order, then slide each row from its old slot to its new
// one (Invert + Play). Rows are keyed by data-row-key so the fresh DOM nodes
// produced by the innerHTML replacement map back to the pre-update snapshot.
// Translates <tr> via translateY — supported by modern Chrome/Firefox/Safari.
export default class extends Controller {
  connect() {
    this._before = this._before.bind(this)
    document.addEventListener("turbo:before-stream-render", this._before)
  }

  disconnect() {
    document.removeEventListener("turbo:before-stream-render", this._before)
  }

  _before(event) {
    const stream = event.target
    if (stream.getAttribute("target") !== "tbody") return
    if (stream.getAttribute("action") !== "update") return
    const tbody = document.getElementById("tbody")
    if (!tbody) return

    const first = new Map()
    for (const r of tbody.querySelectorAll("tr[data-row-key]")) {
      first.set(r.dataset.rowKey, r.getBoundingClientRect().top)
    }

    const defaultRender = event.detail.render
    event.detail.render = (streamEl) => {
      defaultRender(streamEl)
      this._flip(tbody, first)
    }
  }

  _flip(tbody, first) {
    for (const r of tbody.querySelectorAll("tr[data-row-key]")) {
      const oldTop = first.get(r.dataset.rowKey)
      if (oldTop == null) continue            // new row — no animation
      const delta = oldTop - r.getBoundingClientRect().top
      if (delta === 0) continue               // unmoved
      r.style.transition = "none"
      r.style.transform = `translateY(${delta}px)`
      // double rAF so the Invert transform paints before Play transitions it away
      requestAnimationFrame(() => requestAnimationFrame(() => {
        r.style.transition = "transform .45s ease"
        r.style.transform = ""
      }))
    }
  }
}
