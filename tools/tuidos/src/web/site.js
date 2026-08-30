const modal = document.querySelector("#modal");

document.body.addEventListener("tuidos:close-dialog", () => {
  if (modal?.open) modal.close();
});

modal?.addEventListener("close", () => {
  const body = document.querySelector("#modal-body");
  if (body) body.textContent = "Loading…";
});

if (!("commandForElement" in HTMLButtonElement.prototype)) {
  document.body.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button[command]");
    if (!button || !modal) return;
    const command = button.getAttribute("command");
    if (command === "show-modal" && !modal.open) modal.showModal();
    if (command === "close" && modal.open) modal.close();
  });
}

let activeScrollRegionCleanup = () => {};
let activeColumnReorderingCleanup = () => {};

function bindColumnReordering() {
  activeColumnReorderingCleanup();
  activeColumnReorderingCleanup = () => {};

  const board = document.querySelector(".board");
  if (!board) return;

  const movable = [...board.children]
    .filter((child) => child.matches(".board-column"))
    .slice(0, 64);
  const placeholder = [...board.children].find((child) =>
    child.matches(".column-placeholder"),
  );
  const cleanups = [];
  let pending;

  const add = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  };
  const ordered = () =>
    [...board.children].filter((child) => movable.includes(child));
  const keepPlaceholderLast = () => {
    if (placeholder?.parentElement === board) board.append(placeholder);
  };
  const submit = (column) => {
    const input = column.querySelector(
      ".column-reorder-form input[name=position]",
    );
    const form = input?.form || input?.closest("form");
    if (!input || !form) return;
    input.value = String(ordered().indexOf(column));
    form.requestSubmit();
  };
  const moveTo = (column, position) => {
    const current = ordered();
    const remaining = current.filter((item) => item !== column);
    const next = remaining[position];
    if (next) board.insertBefore(column, next);
    else if (placeholder?.parentElement === board) {
      board.insertBefore(column, placeholder);
    } else {
      board.append(column);
    }
    keepPlaceholderLast();
  };
  const cancel = () => {
    if (!pending) return;
    const state = pending;
    pending = null;
    clearTimeout(state.timer);
    state.column.classList.remove("is-reordering");
    if (state.active && state.handle.hasPointerCapture(state.pointerId)) {
      state.handle.releasePointerCapture(state.pointerId);
    }
    return state;
  };
  const stop = () => {
    const state = cancel();
    if (state?.active && ordered().indexOf(state.column) !== state.position) {
      submit(state.column);
    }
  };
  const activate = () => {
    if (!pending) return;
    pending.active = true;
    pending.column.classList.add("is-reordering");
    pending.position = ordered().indexOf(pending.column);
    pending.handle.setPointerCapture(pending.pointerId);
  };
  const onPointerMove = (event) => {
    if (!pending || event.pointerId !== pending.pointerId) return;
    const distance = Math.hypot(
      event.clientX - pending.startX,
      event.clientY - pending.startY,
    );
    if (!pending.active) {
      if (distance > 8) stop();
      return;
    }
    event.preventDefault();
    const siblings = ordered().filter((column) => column !== pending.column);
    const position = siblings.findIndex((column) => {
      const rect = column.getBoundingClientRect();
      return event.clientX < (rect.left + rect.right) / 2;
    });
    moveTo(pending.column, position < 0 ? siblings.length : position);
  };

  add(document, "pointermove", onPointerMove, { passive: false });
  add(document, "pointerup", stop);
  add(document, "pointercancel", stop);

  movable.forEach((column) => {
    const handle = column.querySelector(".column-bar");
    if (!handle) return;
    add(handle, "pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, input, select, textarea, form")
      )
        return;
      stop();
      pending = {
        column,
        handle,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        position: ordered().indexOf(column),
        active: false,
        timer: 0,
      };
      if (event.pointerType === "mouse") {
        event.preventDefault();
        activate();
      } else {
        pending.timer = setTimeout(activate, 350);
      }
    });
    add(handle, "keydown", (event) => {
      if (document.activeElement !== handle) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const current = ordered().indexOf(column);
      const position = event.key === "ArrowLeft" ? current - 1 : current + 1;
      if (position < 0 || position >= movable.length) return;
      event.preventDefault();
      moveTo(column, position);
      submit(column);
    });
  });

  keepPlaceholderLast();
  activeColumnReorderingCleanup = () => {
    cancel();
    cleanups.splice(0).forEach((cleanup) => cleanup());
  };
}

function bindScrollRegion() {
  activeScrollRegionCleanup();
  activeScrollRegionCleanup = () => {};

  const region = document.querySelector(".scroll-region");
  const workspace = document.querySelector(".workspace-body");
  const vertical = region?.querySelector(".os8-scrollbar.os8-vertical");
  const horizontal = region?.querySelector(".os8-scrollbar.os8-horizontal");

  if (!region || !workspace || !vertical || !horizontal) return;

  const cleanups = [];
  let frame = 0;
  const add = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  };
  const schedule = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
  };
  const getParts = (bar) => ({
    bar,
    track: bar.querySelector(".os8-track"),
    thumb: bar.querySelector(".os8-thumb"),
  });
  const axes = [
    {
      ...getParts(vertical),
      horizontal: false,
      start: "top",
      size: "height",
      client: "clientHeight",
      scroll: "scrollTop",
      scrollSize: "scrollHeight",
      direction: ["up", "down"],
    },
    {
      ...getParts(horizontal),
      horizontal: true,
      start: "left",
      size: "width",
      client: "clientWidth",
      scroll: "scrollLeft",
      scrollSize: "scrollWidth",
      direction: ["left", "right"],
    },
  ];

  if (axes.some(({ track, thumb }) => !track || !thumb)) return;

  region.classList.add("has-custom-scrollbars");
  cleanups.push(() => region.classList.remove("has-custom-scrollbars"));

  const update = () => {
    axes.forEach((axis) => {
      const viewport = workspace[axis.client];
      const content = workspace[axis.scrollSize];
      const maxScroll = Math.max(0, content - viewport);
      const trackLength = axis.track[axis.client];
      const thumbLength = Math.min(
        trackLength,
        Math.max(20, trackLength * (viewport / Math.max(content, 1))),
      );
      const travel = Math.max(0, trackLength - thumbLength);
      const offset = maxScroll
        ? Math.min(
            travel,
            Math.max(0, (workspace[axis.scroll] * travel) / maxScroll),
          )
        : 0;

      axis.thumb.style[axis.size] = `${thumbLength}px`;
      axis.thumb.style.transform = axis.horizontal
        ? `translate3d(${offset}px, 0, 0)`
        : `translate3d(0, ${offset}px, 0)`;
      axis.track.classList.toggle("is-disabled", maxScroll === 0);
      axis.bar.querySelectorAll("button[data-direction]").forEach((button) => {
        const direction = button.dataset.direction;
        button.disabled =
          maxScroll === 0 ||
          (direction === axis.direction[0] && workspace[axis.scroll] <= 0) ||
          (direction === axis.direction[1] &&
            workspace[axis.scroll] >= maxScroll);
      });
    });
  };

  add(workspace, "scroll", schedule, { passive: true });
  axes.forEach((axis) => {
    axis.bar.querySelectorAll("button[data-direction]").forEach((button) => {
      add(button, "click", () => {
        const direction = button.dataset.direction;
        const amount = 48;
        const delta = direction === axis.direction[0] ? -amount : amount;
        workspace.scrollBy(axis.horizontal ? { left: delta } : { top: delta });
      });
    });
    add(axis.track, "click", (event) => {
      if (event.target instanceof Node && axis.thumb.contains(event.target))
        return;
      const thumbRect = axis.thumb.getBoundingClientRect();
      const position = axis.horizontal ? event.clientX : event.clientY;
      const center = axis.horizontal
        ? (thumbRect.left + thumbRect.right) / 2
        : (thumbRect.top + thumbRect.bottom) / 2;
      const amount = workspace[axis.client] * 0.8;
      const delta = position < center ? -amount : amount;
      workspace.scrollBy(axis.horizontal ? { left: delta } : { top: delta });
    });

    let drag;
    add(axis.thumb, "pointerdown", (event) => {
      event.preventDefault();
      drag = {
        pointer: axis.horizontal ? event.clientX : event.clientY,
        scroll: workspace[axis.scroll],
      };
      axis.thumb.setPointerCapture(event.pointerId);
    });
    add(axis.thumb, "pointermove", (event) => {
      if (!drag) return;
      const trackLength = axis.track[axis.client];
      const thumbLength = axis.thumb[axis.client];
      const travel = Math.max(0, trackLength - thumbLength);
      const maxScroll = Math.max(
        0,
        workspace[axis.scrollSize] - workspace[axis.client],
      );
      if (!travel || !maxScroll) return;
      const pointer = axis.horizontal ? event.clientX : event.clientY;
      const delta = pointer - drag.pointer;
      workspace[axis.scroll] = Math.max(
        0,
        Math.min(maxScroll, drag.scroll + (delta * maxScroll) / travel),
      );
    });
    const stopDrag = (event) => {
      if (!drag) return;
      drag = null;
      if (axis.thumb.hasPointerCapture(event.pointerId)) {
        axis.thumb.releasePointerCapture(event.pointerId);
      }
    };
    add(axis.thumb, "pointerup", stopDrag);
    add(axis.thumb, "pointercancel", stopDrag);
  });

  add(window, "resize", schedule);
  const observer =
    typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  observer?.observe(workspace);
  observer?.observe(region);
  cleanups.push(() => observer?.disconnect());
  cleanups.push(() => {
    if (frame) cancelAnimationFrame(frame);
  });
  activeScrollRegionCleanup = () => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
  };
  schedule();
}

bindScrollRegion();
bindColumnReordering();
document.body.addEventListener("htmx:after:settle", bindScrollRegion);
document.body.addEventListener("htmx:after:settle", bindColumnReordering);
