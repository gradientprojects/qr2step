// Pure, dependency-light QR helpers: text -> boolean matrix, then a greedy
// rectangle merge so the CAD kernel extrudes a few dozen prisms instead of
// hundreds of 1x1 squares. No replicad/three here — keeps this unit-testable.
import qrcode from "qrcode-generator";

/**
 * Build the QR module matrix for some text.
 * @param {string} text
 * @param {"L"|"M"|"Q"|"H"} ecLevel
 * @returns {{ size:number, matrix:boolean[][] }} size = modules per side
 */
export function buildMatrix(text, ecLevel = "M") {
  // typeNumber 0 = auto-pick the smallest version that fits the data.
  const qr = qrcode(0, ecLevel);
  qr.addData(text ?? "");
  qr.make();
  const size = qr.getModuleCount();
  const matrix = [];
  for (let row = 0; row < size; row++) {
    const line = new Array(size);
    for (let col = 0; col < size; col++) line[col] = qr.isDark(row, col);
    matrix.push(line);
  }
  return { size, matrix };
}

/**
 * Greedy-merge the "on" cells of a boolean matrix into maximal axis-aligned
 * rectangles (greedy meshing). Drastically reduces the number of solids the
 * CAD kernel has to fuse.
 *
 * Coordinates are in module units: a rect covers columns [x, x+w) and
 * rows [y, y+h). Row 0 is the TOP of the QR as drawn.
 *
 * @param {boolean[][]} matrix
 * @returns {{x:number,y:number,w:number,h:number}[]}
 */
export function mergeRects(matrix) {
  const rows = matrix.length;
  if (rows === 0) return [];
  const cols = matrix[0].length;
  const used = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const rects = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!matrix[y][x] || used[y][x]) continue;

      // Extend right along this row.
      let w = 1;
      while (x + w < cols && matrix[y][x + w] && !used[y][x + w]) w++;

      // Extend down as long as every cell in the [x, x+w) span is on/free.
      let h = 1;
      grow: while (y + h < rows) {
        for (let k = x; k < x + w; k++) {
          if (!matrix[y + h][k] || used[y + h][k]) break grow;
        }
        h++;
      }

      for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++) used[j][i] = true;

      rects.push({ x, y, w, h });
    }
  }
  return rects;
}
