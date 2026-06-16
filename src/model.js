// Two-body QR geometry built with replicad (OpenCASCADE).
// Body "light" = base plate + background + quiet zone + panel plate (color 1).
// Body "dark"  = QR modules + outer frame (+ text/SVG, TODO) (color 2).
//
// All units are millimetres. The tile is centred on the origin in XY, with the
// bottom face on the Z=0 plane and growing +Z.
//
// NOTE (v1 scaffold): label-panel TEXT and SVG are not yet extruded — a "blank"
// panel simply extends the plate so it can be modelled in CAD. Text/SVG is the
// next iteration. Everything else (modules, frame, corner radius, magnets,
// raised/flat) is implemented.
import {
  drawRoundedRectangle,
  draw,
  makeCompound,
} from "replicad";
import { buildMatrix, mergeRects } from "./qr.js";

const FLOOR_MIN = 0.6; // min material left under a magnet pocket (mm)
const WALL_MIN = 1.5; // min material between pocket wall and outer edge (mm)
const CHAMFER = 0.5; // magnet lead-in chamfer (mm)

const DEFAULTS = {
  text: "https://example.com",
  ecLevel: "M",
  qrSize: 40, // mm, the QR code area (not the whole tile)
  baseThickness: 3,
  blockHeight: 1,
  quietModules: 4,
  frame: true,
  frameWidth: 3,
  cornerRadius: 2,
  printMode: "raised", // "raised" | "flat"
  flatInlayDepth: 1.0, // mm, depth of the colored top inlay in flat mode
  connectDiagonals: false, // bridge diagonal module touches (manifold/printable)
  bridgeWidth: 0.45, // mm, target connector width — standard 0.4 mm nozzle line
  panelSide: "none", // "none" | "top" | "bottom" | "left" | "right"
  panelContent: "blank", // "blank" | "text" | "svg"
  panelText: "", // panel text string (WIP)
  fontChoice: "archivoBlack", // bundled font id or "uploaded" (WIP)
  textHeight: 6, // mm, target text height (WIP)
  panelDepth: 10,
  magnets: false,
  magnetHoleId: 6.3,
  magnetDepth: 3.3,
  magnetInset: 6, // distance from outer edge to magnet centre (mm)
};

const rect = (w, h, r) => drawRoundedRectangle(w, h, Math.max(0, r));

/**
 * Fuse a list of {x,y,w,h} module rects (module units) into one 2D drawing.
 * Calls onRect(i, total) after each fuse so the UI can show real progress —
 * this loop is the bulk of the build cost.
 */
function modulesDrawing(rects, m, qrLeft, qrTop, onRect) {
  let dwg = null;
  for (let i = 0; i < rects.length; i++) {
    const { x, y, w, h } = rects[i];
    const cx = qrLeft + (x + w / 2) * m;
    const cy = qrTop - (y + h / 2) * m;
    const r = drawRoundedRectangle(w * m, h * m, 0).translate([cx, cy]);
    dwg = dwg ? dwg.fuse(r) : r;
    onRect?.(i + 1, rects.length);
  }
  return dwg;
}

/**
 * Find diagonal "pinch" points — where two diagonally-opposite dark modules
 * meet at a single corner with the other two cells light. Returns a fused
 * drawing of small bridge squares that turn those non-manifold point-contacts
 * into real (manifold, printable) connections. Null if none.
 */
function diagonalBridges(matrix, m, qrLeft, qrTop, bridge) {
  const n = matrix.length;
  const len = m; // capsule spans one module pitch along the diagonal
  let dwg = null;
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const a = matrix[y][x];
      const b = matrix[y][x + 1];
      const c = matrix[y + 1][x];
      const d = matrix[y + 1][x + 1];
      const ad = a && d && !b && !c; // dark on the "\" diagonal
      const bc = b && c && !a && !d; // dark on the "/" diagonal
      if (!ad && !bc) continue;
      const cx = qrLeft + (x + 1) * m; // shared corner of the 2×2 block
      const cy = qrTop - (y + 1) * m;
      // A rounded bar (capsule) rotated to run ALONG the dark-to-dark diagonal,
      // so it welds the two dark cells and barely enters the two light ones.
      const bar = drawRoundedRectangle(len, bridge, bridge / 2)
        .rotate(ad ? -45 : 45)
        .translate([cx, cy]);
      dwg = dwg ? dwg.fuse(bar) : bar;
    }
  }
  return dwg;
}

/** Closed polygon Drawing from [x,y] points (drops a duplicated closing point). */
function polygonDrawing(pts) {
  const p = pts.slice();
  const f = p[0];
  const l = p[p.length - 1];
  if (p.length > 1 && Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6)
    p.pop();
  let d = draw([p[0][0], p[0][1]]);
  for (let i = 1; i < p.length; i++) d = d.lineTo([p[i][0], p[i][1]]);
  return d.close();
}

/**
 * Build a 2D Drawing from parsed SVG shapes, scaled to fit `box` (aspect
 * preserved) and centred in it. `shapes` = [{outer:[[x,y]...], holes:[[...]]}],
 * already y-flipped to model orientation. Returns null if nothing usable.
 */
function buildSvgDrawing(shapes, bounds, box, targetHeight) {
  if (!shapes?.length || !box) return null;
  const svgW = bounds.maxX - bounds.minX || 1;
  const svgH = bounds.maxY - bounds.minY || 1;
  // SVG fills the box; text scales to targetHeight but never past the box.
  const scale = Math.min(
    box.w / svgW,
    box.h / svgH,
    targetHeight ? targetHeight / svgH : Infinity
  );
  const scx = (bounds.minX + bounds.maxX) / 2;
  const scy = (bounds.minY + bounds.maxY) / 2;
  const tx = ([x, y]) => [(x - scx) * scale + box.cx, (y - scy) * scale + box.cy];
  let result = null;
  for (const s of shapes) {
    if (!s.outer || s.outer.length < 3) continue;
    let d = polygonDrawing(s.outer.map(tx));
    for (const h of s.holes || []) {
      if (h.length >= 3) d = d.cut(polygonDrawing(h.map(tx)));
    }
    result = result ? result.fuse(d) : d;
  }
  return result;
}

/**
 * Compute all derived geometry numbers from raw params.
 * Centralised so the UI can show the same derived values (total size, clamps).
 */
export function computeLayout(p) {
  const params = { ...DEFAULTS, ...p };
  const { matrix, size: count } = buildMatrix(params.text, params.ecLevel);
  const m = params.qrSize / count; // module pitch in mm
  // Cap the diagonal-bridge width to ⅓ of a module so it never encroaches
  // enough on light cells to hurt scanning, even on dense codes.
  const bridgeEff = Math.min(params.bridgeWidth, m / 3);
  const bridgeCapped = bridgeEff < params.bridgeWidth - 1e-9;
  const qz = params.quietModules * m;
  const innerSide = params.qrSize + 2 * qz; // light field around the QR (square)

  const d = params.panelSide === "none" ? 0 : params.panelDepth;
  let innerW = innerSide;
  let innerH = innerSide;
  if (params.panelSide === "top" || params.panelSide === "bottom") innerH += d;
  if (params.panelSide === "left" || params.panelSide === "right") innerW += d;

  const fw = params.frame ? params.frameWidth : 0;
  const tileW = innerW + 2 * fw;
  const tileH = innerH + 2 * fw;

  // QR centre is pushed away from the panel by half the panel depth.
  let qrCx = 0;
  let qrCy = 0;
  if (params.panelSide === "bottom") qrCy = d / 2;
  if (params.panelSide === "top") qrCy = -d / 2;
  if (params.panelSide === "right") qrCx = -d / 2;
  if (params.panelSide === "left") qrCx = d / 2;

  const cornerR = Math.min(params.cornerRadius, qz + fw); // clamp to border
  const innerR = Math.max(0, cornerR - fw);

  // Panel content box (tile-centred coords), padded off the frame/quiet zone.
  let panelBox = null;
  if (params.panelSide !== "none" && d > 0) {
    const pad = Math.min(2, d * 0.15);
    if (params.panelSide === "bottom")
      panelBox = { cx: 0, cy: -innerH / 2 + d / 2, w: innerW - 2 * pad, h: d - 2 * pad };
    else if (params.panelSide === "top")
      panelBox = { cx: 0, cy: innerH / 2 - d / 2, w: innerW - 2 * pad, h: d - 2 * pad };
    else if (params.panelSide === "left")
      panelBox = { cx: -innerW / 2 + d / 2, cy: 0, w: d - 2 * pad, h: innerH - 2 * pad };
    else if (params.panelSide === "right")
      panelBox = { cx: innerW / 2 - d / 2, cy: 0, w: d - 2 * pad, h: innerH - 2 * pad };
  }

  // In flat mode the dark code is a thin top inlay; the rest of the thickness
  // is solid base (and is where magnets live).
  const inlay = params.printMode === "flat" ? params.flatInlayDepth : 0;

  // Base thickness: when magnets are on, auto-raise so magnet pocket + floor
  // (+ the flat inlay above) always fit. No penalty when magnets are off.
  const baseThickness = params.magnets
    ? Math.max(params.baseThickness, params.magnetDepth + FLOOR_MIN + inlay)
    : params.baseThickness;
  const baseRaised = baseThickness > params.baseThickness + 1e-9;

  // Magnet clamps.
  const holeR = params.magnetHoleId / 2;
  const insetMin = holeR + WALL_MIN + cornerR; // (+fw handled via cornerR clamp)
  const insetMax = Math.min(tileW, tileH) / 2; // can't pass centre
  const inset = Math.min(Math.max(params.magnetInset, insetMin), insetMax);
  const spacingX = tileW - 2 * inset;
  const spacingY = tileH - 2 * inset;
  const magnetDepth = Math.min(params.magnetDepth, baseThickness - FLOOR_MIN);
  const magnetFits = insetMin <= insetMax && magnetDepth > 0;

  return {
    params,
    matrix,
    count,
    m,
    bridgeEff,
    bridgeCapped,
    qz,
    fw,
    tileW,
    tileH,
    innerSide, // QR field incl. quiet zone (square), before frame/panel
    qrCx,
    qrCy,
    cornerR,
    innerR,
    panelBox,
    innerW,
    innerH,
    baseThickness,
    baseRaised,
    inlay,
    holeR,
    inset,
    insetMin,
    spacingX,
    spacingY,
    magnetDepth,
    magnetFits,
  };
}

/** Revolved cut tool for one magnet pocket (chamfered mouth at z=0). */
function magnetTool(holeR, chamfer, depth) {
  // Profile in the local XZ plane (x = radius from axis, y -> Z when sketched),
  // revolved 360° about the Z axis. Mouth (z=0) is wider by `chamfer`.
  const profile = draw([0, 0])
    .lineTo([holeR + chamfer, 0])
    .lineTo([holeR, chamfer])
    .lineTo([holeR, depth])
    .lineTo([0, depth])
    .close();
  return profile.sketchOnPlane("XZ").revolve([0, 0, 1]);
}

/**
 * Build the two solid bodies.
 * @param {object} p raw params
 * @param {(frac:number,label:string)=>void} [report] progress callback,
 *   frac in [0,0.85] (meshing/finishing happens in the worker after this).
 * @returns {{ light: Shape3D, dark: Shape3D, layout: object }}
 */
export function buildModel(p, report = () => {}) {
  const L = computeLayout(p);
  const { params, matrix, m, qz, tileW, tileH, qrCx, qrCy, cornerR, innerR, fw, baseThickness, inlay } = L;

  const qrLeft = qrCx - params.qrSize / 2;
  const qrTop = qrCy + params.qrSize / 2;

  // ---- dark body (color 2): modules (+ frame) ----
  const rects = mergeRects(matrix);
  // Module fusing dominates the build → maps to 0.05 .. 0.55 of the bar.
  let dark2d = modulesDrawing(rects, m, qrLeft, qrTop, (i, total) =>
    report(0.05 + 0.5 * (i / total), "modules")
  );

  // Bridge diagonal touches so the dark body is manifold and prints connected.
  if (params.connectDiagonals && L.bridgeEff > 0 && dark2d) {
    const bridges = diagonalBridges(matrix, m, qrLeft, qrTop, L.bridgeEff);
    if (bridges) dark2d = dark2d.fuse(bridges);
  }

  if (params.frame && fw > 0) {
    report(0.58, "frame");
    const ring = rect(tileW, tileH, cornerR).cut(
      rect(tileW - 2 * fw, tileH - 2 * fw, innerR)
    );
    dark2d = dark2d ? dark2d.fuse(ring) : ring;
  }

  // Label-panel content (SVG image or rendered text, both delivered as polygon
  // shapes) → part of the color-2 (dark) body, fit into the panel box.
  if (
    (params.panelContent === "svg" || params.panelContent === "text") &&
    params.svgShapes &&
    L.panelBox
  ) {
    report(0.6, "panel");
    const content = buildSvgDrawing(
      params.svgShapes,
      params.svgBounds,
      L.panelBox,
      params.svgTargetHeight
    );
    if (content) dark2d = dark2d ? dark2d.fuse(content) : content;
  }

  // ---- light body (color 1): full plate ----
  const plate2d = rect(tileW, tileH, cornerR);

  let light;
  let dark;
  if (params.printMode === "flat") {
    // Flat: dark is a thin color inlay set into the TOP of the plate; the solid
    // base below stays light and houses the magnets. Top surface is flush.
    report(0.62, "plate");
    const inlayDepth = Math.min(inlay, baseThickness - FLOOR_MIN);
    const plate = plate2d.sketchOnPlane().extrude(baseThickness);
    const darkInlay = dark2d
      ? dark2d
          .sketchOnPlane()
          .extrude(inlayDepth)
          .translate([0, 0, baseThickness - inlayDepth])
      : null;
    report(0.7, "shape");
    light = darkInlay ? plate.cut(darkInlay.clone()) : plate;
    dark = darkInlay;
  } else {
    // Raised: solid plate, dark sits +blockHeight on top.
    report(0.62, "plate");
    light = plate2d.sketchOnPlane().extrude(baseThickness);
    report(0.7, "shape");
    dark = dark2d
      ? dark2d
          .sketchOnPlane()
          .extrude(params.blockHeight)
          .translate([0, 0, baseThickness])
      : null;
  }

  // ---- magnets: subtract chamfered pockets from the light body ----
  if (params.magnets && L.magnetFits) {
    const hx = tileW / 2 - L.inset;
    const hy = tileH / 2 - L.inset;
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    corners.forEach(([sx, sy], k) => {
      const tool = magnetTool(L.holeR, CHAMFER, L.magnetDepth).translate([
        sx * hx,
        sy * hy,
        0,
      ]);
      light = light.cut(tool);
      report(0.78 + 0.07 * ((k + 1) / 4), "magnets");
    });
  }

  return { light, dark, layout: L };
}

/** Mesh both bodies for the three.js preview (called in the worker). */
export function meshModel({ light, dark }, report = () => {}) {
  const shapes = [];
  if (light) {
    report(0.88, "mesh");
    shapes.push({ name: "light", faces: light.mesh(), edges: light.meshEdges() });
  }
  if (dark) {
    report(0.94, "mesh");
    shapes.push({ name: "dark", faces: dark.mesh(), edges: dark.meshEdges() });
  }
  report(0.99, "mesh");
  return shapes;
}

/**
 * Build the export shape.
 * - Raised: the two colors differ by height, so we fuse into ONE editable solid
 *   (two-color printing via a filament color-change at the module height).
 * - Flat: colors are coplanar, so keep two separate bodies for multi-material.
 */
export function compound({ light, dark, layout }) {
  const parts = [light, dark].filter(Boolean);
  if (parts.length < 2) return parts[0];
  if (layout?.params?.printMode === "raised") return light.fuse(dark);
  return makeCompound(parts);
}
