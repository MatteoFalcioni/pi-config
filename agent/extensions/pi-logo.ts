import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Color = "C" | "B" | "Y";
type Cell = " " | Color | Lowercase<Color>;

// The large, three-colour mark.
const MARK = [
  "CCC.",
  "B.C.",
  "BB.Y",
  "B..Y",
] as const;

const RGB: Record<Color, string> = {
  C: "240;144;130", // coral
  B: "77;154;191",  // blue
  Y: "241;190;88",  // yellow
};

const RESET = "\x1b[0m";

function makeCanvas(width: number, height: number): Cell[][] {
  return Array.from({ length: height }, () =>
    Array<Cell>(width).fill(" "),
  );
}

function drawLargePi(
  canvas: Cell[][],
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
): void {
  for (let markY = 0; markY < 4; markY++) {
    for (let markX = 0; markX < 4; markX++) {
      const color = MARK[markY][markX];

      if (color === ".") continue;

      for (let dy = 0; dy < cellHeight; dy++) {
        for (let dx = 0; dx < cellWidth; dx++) {
          canvas[y + markY * cellHeight + dy][
            x + markX * cellWidth + dx
          ] = color as Color;
        }
      }
    }
  }
}

function drawSmallPis(canvas: Cell[][], largePiX: number): void {
  const width = canvas[0].length;
  const rows = [1, 4, 7, 10, 14];
  const colors: Color[] = ["C", "B", "Y"];

  rows.forEach((y, rowIndex) => {
    // Stagger alternate rows, but keep regular spacing across the band.
    const firstX = 6 + (rowIndex % 2) * 6;

    for (let x = firstX; x < width; x += 10) {
      // Reserve a little breathing room around the big logo.
      if (x >= largePiX - 2 && x < largePiX + 26) continue;

      const color = colors[(rowIndex + Math.floor(x / 13)) % 3];

      // Lowercase means "render a literal π in this colour".
      canvas[y][x] = color.toLowerCase() as Lowercase<Color>;
    }
  });
}

function renderRow(row: Cell[]): string {
  let result = "";

  for (let x = 0; x < row.length;) {
    const cell = row[x];

    if (cell === " ") {
      result += " ";
      x++;
      continue;
    }

    if (cell === "c" || cell === "b" || cell === "y") {
      const color = RGB[cell.toUpperCase() as Color];
      result += `\x1b[38;2;${color}mπ${RESET}`;
      x++;
      continue;
    }

    // Paint the large logo with background colour rather than █.
    // This avoids the horizontal gaps visible in your screenshot.
    let end = x + 1;
    while (end < row.length && row[end] === cell) end++;

    result +=
      `\x1b[48;2;${RGB[cell]}m` +
      " ".repeat(end - x) +
      RESET;

    x = end;
  }

  return result;
}

function renderHeader(width: number): string[] {
  if (width < 8) return [""];

  if (width >= 24) {
    const canvas = makeCanvas(width, 16);
    const largePiX = Math.floor((width - 24) / 2);

    if (width >= 48) drawSmallPis(canvas, largePiX);
    drawLargePi(canvas, largePiX, 2, 6, 3);

    return canvas.map(renderRow);
  }

  // On narrow panes, show only a scaled-down large logo.
  const cellWidth = width >= 16 ? 4 : 2;
  const cellHeight = width >= 16 ? 2 : 1;
  const canvas = makeCanvas(width, cellHeight * 4 + 4);

  drawLargePi(
    canvas,
    Math.floor((width - cellWidth * 4) / 2),
    2,
    cellWidth,
    cellHeight,
  );

  return canvas.map(renderRow);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, _theme) => ({
      render(width: number): string[] {
        return renderHeader(width);
      },
      invalidate() {},
    }));
  });

  pi.registerCommand("builtin-header", {
    description: "Restore Pi's built-in header",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}