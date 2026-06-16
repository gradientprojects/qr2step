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
  ecLevel: "Q",
  qrSize: 40, // mm, the QR code area (not the whole tile)
  baseThickness: 3,
  blockHeight: 1,
  quietModules: 4,
  frame: true,
  frameWidth: 3,
  cornerRadius: 5,
  corners: { tl: true, tr: true, bl: true, br: true }, // which corners get the radius
  printMode: "raised", // "raised" | "flat"
  flatInlayDepth: 1.0, // mm, depth of the colored top inlay in flat mode
  connectDiagonals: true, // bridge diagonal module touches (manifold/printable)
  bridgeWidth: 0.45, // mm, target connector width — standard 0.4 mm nozzle line
  panelSide: "none", // "none" | "top" | "bottom" | "left" | "right"
  panelContent: "text", // "blank" | "text" | "svg"
  panelText: "", // panel text string
  fontChoice: "archivoBlack", // bundled font id
  textHeight: 6, // mm, target text height
  alignH: "center", // text/svg horizontal align in panel: "left"|"center"|"right"
  alignV: "center", // text/svg vertical align in panel: "top"|"center"|"bottom"
  panelDepth: 10,
  magnets: false,
  magnetHoleId: 6.3,
  magnetDepth: 3.3,
  magnetInset: 6, // distance from outer edge to magnet centre (mm)
};

const rect = (w, h, r) => drawRoundedRectangle(w, h, Math.max(0, r));

const ALL_CORNERS = { tl: true, tr: true, bl: true, br: true };

/**
 * Centred rectangle that rounds ONLY the corners flagged in `mask`
 * ({tl,tr,bl,br} booleans), all to the same radius `r`. Square corners stay
 * sharp. Falls back to the plain all-corner rounded rect when every corner is
 * on (or r<=0). The path starts at the mid-bottom edge so `close()` never lands
 * on a corner — each corner is then selectable via replicad's customCorner.
 */
function maskedRect(w, h, r, mask = ALL_CORNERS) {
  const on = { ...ALL_CORNERS, ...mask };
  if (!(r > 0) || (on.tl && on.tr && on.bl && on.br))
    return drawRoundedRectangle(w, h, Math.max(0, r));
  const hw = w / 2;
  const hh = h / 2;
  const pen = draw([0, -hh]);
  pen.lineTo([hw, -hh]); // arrive bottom-right
  if (on.br) pen.customCorner(r);
  pen.lineTo([hw, hh]); // arrive top-right
  if (on.tr) pen.customCorner(r);
  pen.lineTo([-hw, hh]); // arrive top-left
  if (on.tl) pen.customCorner(r);
  pen.lineTo([-hw, -hh]); // arrive bottom-left
  if (on.bl) pen.customCorner(r);
  pen.lineTo([0, -hh]); // back to mid-bottom (no corner here)
  return pen.close();
}

/**
 * Fuse a list of {x,y,w,h} module rects (module units) into one 2D drawing.
 * Uses a balanced pairwise (divide-and-conquer) fuse instead of accumulating
 * into one growing shape: that keeps each boolean operating on small shapes,
 * turning the dominant build cost from ~O(n²) into ~O(n log n). Calls
 * onRect(done, total) so the UI can show real progress.
 */
function modulesDrawing(rects, m, qrLeft, qrTop, onRect) {
  if (!rects.length) return null;
  let level = rects.map(({ x, y, w, h }) => {
    const cx = qrLeft + (x + w / 2) * m;
    const cy = qrTop - (y + h / 2) * m;
    return drawRoundedRectangle(w * m, h * m, 0).translate([cx, cy]);
  });
  const total = level.length;
  let done = 0;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(level[i].fuse(level[i + 1]));
        onRect?.(++done, total);
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
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

// Collapse points closer than this (mm). After scaling glyph/SVG outlines down
// to a few mm, curve tessellation leaves sub-tolerance "sliver" edges that
// survive the boolean but crash triangulation; merging them keeps the model
// meshable. 0.03 mm is well below print resolution.
const MERGE_TOL = 0.03;

/** Closed polygon Drawing from [x,y] points (mm), with slivers merged out. */
function polygonDrawing(pts) {
  const p = [];
  for (const pt of pts) {
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const prev = p[p.length - 1];
    if (!prev || Math.hypot(prev[0] - pt[0], prev[1] - pt[1]) > MERGE_TOL) p.push(pt);
  }
  if (p.length > 1) {
    const f = p[0];
    const l = p[p.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= MERGE_TOL) p.pop();
  }
  if (p.length < 3) throw new Error("degenerate polygon");
  let d = draw([p[0][0], p[0][1]]);
  for (let i = 1; i < p.length; i++) d = d.lineTo([p[i][0], p[i][1]]);
  return d.close();
}

/**
 * Build a 2D Drawing from parsed SVG shapes, scaled to fit `box` (aspect
 * preserved) and centred in it. `shapes` = [{outer:[[x,y]...], holes:[[...]]}],
 * already y-flipped to model orientation. Returns null if nothing usable.
 */
function buildSvgDrawing(shapes, bounds, box, targetHeight, align) {
  if (!shapes?.length || !box) return null;
  const svgW = bounds.maxX - bounds.minX || 1;
  const svgH = bounds.maxY - bounds.minY || 1;
  // SVG fills the box; text scales to targetHeight but never past the box.
  const scale = Math.min(
    box.w / svgW,
    box.h / svgH,
    targetHeight ? targetHeight / svgH : Infinity
  );
  // Align within the panel box: shift by the leftover slack on each axis.
  // (model y is up: "top" is +y.) Defaults to centred.
  const slackX = (box.w - svgW * scale) / 2;
  const slackY = (box.h - svgH * scale) / 2;
  const offX = align?.h === "left" ? -slackX : align?.h === "right" ? slackX : 0;
  const offY = align?.v === "bottom" ? -slackY : align?.v === "top" ? slackY : 0;
  const scx = (bounds.minX + bounds.maxX) / 2;
  const scy = (bounds.minY + bounds.maxY) / 2;
  const tx = ([x, y]) => [
    (x - scx) * scale + box.cx + offX,
    (y - scy) * scale + box.cy + offY,
  ];
  let result = null;
  for (const s of shapes) {
    if (!s.outer || s.outer.length < 3) continue;
    try {
      let d = polygonDrawing(s.outer.map(tx));
      for (const h of s.holes || []) {
        if (h.length < 3) continue;
        try {
          d = d.cut(polygonDrawing(h.map(tx)));
        } catch {
          /* skip an unbuildable counter rather than dropping the whole glyph */
        }
      }
      result = result ? result.fuse(d) : d;
    } catch {
      /* skip a glyph the kernel can't build rather than aborting the model */
    }
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
    const ring = maskedRect(tileW, tileH, cornerR, params.corners).cut(
      maskedRect(tileW - 2 * fw, tileH - 2 * fw, innerR, params.corners)
    );
    dark2d = dark2d ? dark2d.fuse(ring) : ring;
  }

  // Label-panel content (SVG image or rendered text, both delivered as polygon
  // shapes). Kept as its OWN drawing so a problem glyph can't corrupt the module
  // body — it's fused/extruded with a fallback below.
  let content2d = null;
  if (
    (params.panelContent === "svg" || params.panelContent === "text") &&
    params.svgShapes &&
    L.panelBox
  ) {
    report(0.6, "panel");
    try {
      content2d = buildSvgDrawing(
        params.svgShapes,
        params.svgBounds,
        L.panelBox,
        params.svgTargetHeight,
        { h: params.alignH, v: params.alignV }
      );
    } catch (e) {
      L.contentDropped = true;
    }
  }

  // ---- light body (color 1): full plate ----
  const plate2d = maskedRect(tileW, tileH, cornerR, params.corners);
  const inlayDepth = Math.min(inlay, baseThickness - FLOOR_MIN);

  // Combined dark 2D (modules+frame + optional panel content), fused once.
  const dark2dFull =
    content2d && dark2d ? dark2d.fuse(content2d) : content2d || dark2d;
  const extrudeAt = (d, height, z) =>
    d.sketchOnPlane().extrude(height).translate([0, 0, z]);

  // Assemble light + dark for the given print mode. If panel content makes the
  // kernel fail anywhere downstream, the worker rebuilds this model with content
  // stripped (panelContent "blank") — so resilience lives there, not here.
  let light;
  let dark;
  if (params.printMode === "flat") {
    // Flat: dark is a thin color inlay set into the TOP of the plate; the solid
    // base below stays light and houses the magnets.
    report(0.62, "plate");
    const plate = plate2d.sketchOnPlane().extrude(baseThickness);
    report(0.7, "shape");
    if (dark2dFull) {
      const z = baseThickness - inlayDepth;
      dark = extrudeAt(dark2dFull, inlayDepth, z);
      // Cut the pocket with a tool that OVERSHOOTS the top face — a coplanar
      // tool/plate top face produces zero-area faces that pass the boolean but
      // crash meshing (the flat-mode "mesh" failures).
      const tool = extrudeAt(dark2dFull.clone(), inlayDepth + 0.02, z);
      light = plate.cut(tool);
    } else {
      light = plate;
    }
  } else {
    // Raised: solid plate, dark sits +blockHeight on top.
    report(0.62, "plate");
    light = plate2d.sketchOnPlane().extrude(baseThickness);
    report(0.7, "shape");
    dark = dark2dFull ? extrudeAt(dark2dFull, params.blockHeight, baseThickness) : null;
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
  const meshOne = (body, name) => {
    try {
      return { name, faces: body.mesh(), edges: body.meshEdges() };
    } catch (e) {
      // Localize the failure so the error names the body, not just "mesh".
      throw new Error(`mesh failed on ${name} body (${e?.message ?? e})`);
    }
  };
  if (light) {
    report(0.88, "mesh");
    shapes.push(meshOne(light, "light"));
  }
  if (dark) {
    report(0.94, "mesh");
    shapes.push(meshOne(dark, "dark"));
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
