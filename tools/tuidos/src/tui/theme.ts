// Basecamp-inspired, opinionated palette. Calm but clear: one accent for the
// important noun, dim for meta, magenta for the id prefix, green/red for
// outcomes. A flat object of hex strings — no runtime deps, no functions, so
// it is trivially shared and never re-renders. The whole interface reads from
// here, so every surface speaks the same visual language.
export const theme = {
  // The default ink. Most text is this off-white; importance is shown by
  // raising to accent or lowering to muted, never by introducing new hues.
  text: "#c0caf5",
  // The primary noun — names, titles, the thing the line is about.
  accent: "#7aa2f7",
  // Meta: ages, labels, the "rest" of an id, hints. Anything you skim past.
  muted: "#565f89",
  // Section + column headers — a touch brighter than accent so structure pops.
  header: "#7dcfff",
  // The id prefix highlight. Distinct from accent (names) and ok (✓): a peer
  // looking at a line can tell a name from an id from a status at a glance.
  uid: "#bb9af7",
  // Outcomes.
  ok: "#9ece6a",
  error: "#f7768e",
  warn: "#e0af68",
  // Borders: a selected surface earns the accent; the rest stay dim.
  selBorder: "#7aa2f7",
  border: "#3b4261",
  // Panels (modals) sit on a slightly darker field than the terminal default.
  panelBg: "#16161e",
  inputBg: "#1f2335",
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
