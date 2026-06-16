// Pure-JS tests for the QR matrix + greedy merge. No CAD/WASM needed.
// Run with: npm test
import { buildMatrix, mergeRects } from "../src/qr.js";

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  }
};

const TEXTS = [
  "https://example.com",
  "https://gradientprojects.co/very/long/path?x=1&y=2",
  "A",
];
const ECS = ["L", "M", "Q", "H"];

// 1) Greedy merge exactly covers the "on" cells: no gaps, no overlaps, no
//    OFF cells covered.
for (const text of TEXTS) {
  for (const ec of ECS) {
    const { size, matrix } = buildMatrix(text, ec);
    const rects = mergeRects(matrix);

    const covered = Array.from({ length: size }, () => new Array(size).fill(false));
    let onCount = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (matrix[y][x]) onCount++;

    let area = 0;
    let overlap = false;
    for (const { x, y, w, h } of rects) {
      area += w * h;
      for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++) {
          if (covered[j][i]) overlap = true;
          covered[j][i] = true;
          check(matrix[j][i], `rect covers an OFF cell at ${i},${j}`);
        }
    }
    check(!overlap, `rects overlap (${text}/${ec})`);
    check(area === onCount, `area ${area} != onCount ${onCount} (${text}/${ec})`);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        check(matrix[y][x] === covered[y][x], `coverage mismatch ${x},${y}`);
  }
}

// 2) Determinism: the same URL + EC level always yields an identical matrix.
for (const text of TEXTS) {
  for (const ec of ECS) {
    const a = buildMatrix(text, ec);
    const b = buildMatrix(text, ec);
    check(
      JSON.stringify(a.matrix) === JSON.stringify(b.matrix),
      `non-deterministic matrix for ${text}/${ec}`
    );
  }
}

// 3) Sanity: changing the EC level (or the text) changes the encoded matrix.
const base = buildMatrix("https://example.com", "M");
check(
  JSON.stringify(base.matrix) !== JSON.stringify(buildMatrix("https://example.com", "H").matrix),
  "EC level change should alter the matrix"
);
check(
  JSON.stringify(base.matrix) !== JSON.stringify(buildMatrix("https://example.org", "M").matrix),
  "text change should alter the matrix"
);

// 4) Diagonal-pinch detection (mirrors model.js diagonalBridges logic).
function countPinches(matrix) {
  const n = matrix.length;
  let count = 0;
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const a = matrix[y][x], b = matrix[y][x + 1], c = matrix[y + 1][x], d = matrix[y + 1][x + 1];
      if ((a && d && !b && !c) || (b && c && !a && !d)) count++;
    }
  return count;
}
// A 3×3 checkerboard has 4 internal 2×2 blocks, every one a pinch.
const checker = [
  [true, false, true],
  [false, true, false],
  [true, false, true],
];
check(countPinches(checker) === 4, `checkerboard should have 4 pinches, got ${countPinches(checker)}`);
// A solid block has none.
const solid = [
  [true, true, true],
  [true, true, true],
  [true, true, true],
];
check(countPinches(solid) === 0, `solid block should have 0 pinches, got ${countPinches(solid)}`);
// Real QR codes have pinches to bridge (sanity: at least one).
check(countPinches(buildMatrix("https://example.com", "M").matrix) > 0, "real QR should have pinches");

console.log(
  failures === 0
    ? "ALL TESTS PASSED (coverage + determinism + pinch detection)"
    : `${failures} TESTS FAILED`
);
process.exit(failures === 0 ? 0 : 1);
