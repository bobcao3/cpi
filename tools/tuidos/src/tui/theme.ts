export const theme = {
  text: "#c0caf5",
  accent: "#7aa2f7",
  muted: "#565f89",
  header: "#7dcfff",
  uid: "#bb9af7",
  ok: "#9ece6a",
  error: "#f7768e",
  warn: "#e0af68",
  selBorder: "#7aa2f7",
  border: "#3b4261",
  panelBg: "#16161e",
  inputBg: "#1f2335",
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme];
