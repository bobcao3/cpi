export const COLUMN_PADDING = "\u0001";

const HORIZONTAL = new Set("─┬┴┼");
const VERTICAL = new Set("│├┤┼");
const CORNERS = { "┌": ["┐", "└", "┘"], "╭": ["╮", "╰", "╯"] };

export function refine_flowchart(text, compact) {
  const rows = text.split("\n").map((line) => {
    let style = "";
    const cells = [];
    for (const [token] of line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/gu)) {
      if (token.startsWith("\x1b")) {
        style = token === "\x1b[0m" || token === "\x1b[39m" ? "" : token;
      } else {
        cells.push({ char: token, style });
      }
    }
    return cells;
  });
  const char = (x, y) => rows[y]?.[x]?.char ?? " ";
  const boxes = [];
  for (let top = 0; top < rows.length; top++) {
    for (let left = 0; left < rows[top].length; left++) {
      const corners = CORNERS[char(left, top)];
      if (!corners) continue;
      let right = left + 1;
      while (HORIZONTAL.has(char(right, top))) right++;
      if (char(right, top) !== corners[0]) continue;
      let bottom = top + 1;
      while (
        VERTICAL.has(char(left, bottom)) &&
        VERTICAL.has(char(right, bottom))
      )
        bottom++;
      if (
        char(left, bottom) !== corners[1] ||
        char(right, bottom) !== corners[2]
      )
        continue;
      let valid = true;
      for (let x = left + 1; x < right; x++)
        valid &&= HORIZONTAL.has(char(x, bottom));
      if (valid) boxes.push({ top, bottom, left, right });
    }
  }
  for (const box of boxes) {
    for (let x = box.left + 1; x < box.right; x++) {
      if ("│┌┐├┤┬┼▼".includes(char(x, box.top - 1))) {
        const cell = rows[box.top][x];
        if (cell.char === "─") cell.char = "┴";
        else if (cell.char === "┬") cell.char = "┼";
      }
      if ("│└┘├┤┴┼▲".includes(char(x, box.bottom + 1))) {
        const cell = rows[box.bottom][x];
        if (cell.char === "─") cell.char = "┬";
        else if (cell.char === "┴") cell.char = "┼";
      }
    }
    for (let y = box.top + 1; y < box.bottom; y++) {
      if (
        "─┌└├┬┴┼►".includes(char(box.left - 1, y)) &&
        char(box.left, y) === "│"
      )
        rows[y][box.left].char = "┤";
      if (
        "─┐┘┤┬┴┼◄".includes(char(box.right + 1, y)) &&
        char(box.right, y) === "│"
      )
        rows[y][box.right].char = "├";
    }
  }
  return rows
    .filter((row, y) => {
      if (!compact) return true;
      let padding = false;
      for (let x = 0; x < row.length; x++) {
        const glyph = row[x].char;
        if (glyph === " ") continue;
        if (glyph !== "│") return true;
        for (const box of boxes) {
          if (y <= box.top || y >= box.bottom) continue;
          if (x > box.left && x < box.right) return true;
          if (x === box.left || x === box.right) padding = true;
        }
      }
      return !padding;
    })
    .map((row) => {
      let style = "";
      let line = "";
      for (const cell of row) {
        if (cell.style !== style) {
          if (style) line += "\x1b[0m";
          line += cell.style;
          style = cell.style;
        }
        line += cell.char;
      }
      return line + (style ? "\x1b[0m" : "");
    })
    .join("\n");
}
