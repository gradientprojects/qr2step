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
  exportSTEP,
} from "replicad";
import polygonClipping from "polygon-clipping";
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
  magnetMode: "inset", // "inset" (symmetric) | "spacing" (independent X/Y)
  magnetInset: 6, // distance from outer edge to magnet centre (mm)
  magnetSpacingX: 28, // centre-to-centre across width (spacing mode)
  magnetSpacingY: 28, // centre-to-centre across height (spacing mode)
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
 * Each {x,y,w,h} module rect (module units) → a closed polygon ring in mm,
 * ready for polygon-clipping. Row 0 is the TOP of the QR, so y grows downward.
 */
function modulePolys(rects, m, qrLeft, qrTop) {
  return rects.map(({ x, y, w, h }) => {
    const x0 = qrLeft + x * m;
    const x1 = qrLeft + (x + w) * m;
    const yTop = qrTop - y * m;
    const yBot = qrTop - (y + h) * m;
    return [[[x0, yBot], [x1, yBot], [x1, yTop], [x0, yTop], [x0, yBot]]];
  });
}

/**
 * Polygons for the diagonal "pinch" bridges. Where two diagonally-opposite dark
 * modules meet at a single corner with the other two cells light, emit a thin
 * bar (one module pitch long, `bridge` wide) rotated to run ALONG the dark-to-
 * dark diagonal. Unioned with the module polygons (below) this welds the two
 * dark cells into one manifold, printable region and barely enters the light
 * ones. Returned as plain rotated rectangles (not capsules): the rounded ends
 * sit fully inside the dark squares, so they'd be invisible anyway — and going
 * through polygon-clipping keeps the join sliver-free, which sharp-vs-rounded
 * does not affect.
 */
function bridgePolys(matrix, m, qrLeft, qrTop, bridge) {
  const n = matrix.length;
  const hl = m / 2; // half length: spans one module pitch along the diagonal
  const hw = bridge / 2;
  const SIN45 = Math.SQRT1_2;
  const polys = [];
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
      // Rotate the axis-aligned rect [±hl,±hw] about the corner so its long axis
      // runs along the dark diagonal. "\" (ad) points +x/−y (−45°), "/" (bc)
      // points +x/+y (+45°). Rotation by θ: (x',y') = (lx·c−ly·s, lx·s+ly·c).
      const c45 = SIN45;
      const s45 = ad ? -SIN45 : SIN45;
      const corner = (lx, ly) => [
        cx + lx * c45 - ly * s45,
        cy + lx * s45 + ly * c45,
      ];
      polys.push([[
        corner(-hl, -hw), corner(hl, -hw), corner(hl, hw), corner(-hl, hw), corner(-hl, -hw),
      ]]);
    }
  }
  return polys;
}

/**
 * Union a set of polygon rings (modules + bridges) into one 2D drawing.
 *
 * The module rects from greedy-meshing TILE the dark region — they share
 * exactly coincident edges, and the bridges overlap module corners. replicad's
 * 2D blueprint boolean is fragile on coincident/collinear edges and would
 * intermittently abort (a bare kernel "24") on dense codes, or leave thin
 * slivers that later crashed meshing. So we union everything with polygon-
 * clipping (martinez) — robust to coincident edges — then build replicad
 * geometry from the few resulting polygons: edge-sharing rects merge into one
 * clean ring, bridges weld diagonal cells transversally (no slivers), and
 * enclosed light cells become holes. Calls onRect(done,total) for progress.
 */
function unionToDrawing(polys, onRect) {
  if (!polys.length) return null;
  const merged = polygonClipping.union(polys[0], ...polys.slice(1));
  const total = merged.length || 1;
  let done = 0;
  let result = null;
  for (const poly of merged) {
    const outer = poly[0];
    if (!outer || outer.length < 4) {
      onRect?.(++done, total);
      continue;
    }
    try {
      let d = polygonDrawing(outer);
      for (let i = 1; i < poly.length; i++) {
        if (poly[i].length < 4) continue;
        try {
          d = d.cut(polygonDrawing(poly[i]));
        } catch {
          /* skip an unbuildable hole rather than dropping the whole region */
        }
      }
      result = result ? result.fuse(d) : d; // disjoint regions: a safe fuse
    } catch {
      /* skip a region the kernel can't build rather than aborting the model */
    }
    onRect?.(++done, total);
  }
  return result;
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
  // Smallest QR-area size that would lift the cap for the requested bridge width
  // (the cap is module/3, and module = qrSize/count, so qrSize ≥ 3·width·count).
  const bridgeFull = params.bridgeWidth * 3 * count;
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

  // Magnet clamps. Two DOFs (insetX/insetY from the side edges) so "XY pattern"
  // mode can set each axis independently; "inset" mode uses one symmetric value.
  const holeR = params.magnetHoleId / 2;
  const insetMin = holeR + WALL_MIN + cornerR; // (+fw handled via cornerR clamp)
  const insetMaxX = tileW / 2; // can't pass centre
  const insetMaxY = tileH / 2;
  const clampInset = (v, hi) => Math.min(Math.max(v, insetMin), hi);
  let insetX, insetY;
  if (params.magnetMode === "spacing") {
    insetX = clampInset((tileW - params.magnetSpacingX) / 2, insetMaxX);
    insetY = clampInset((tileH - params.magnetSpacingY) / 2, insetMaxY);
  } else {
    insetX = insetY = clampInset(params.magnetInset, Math.min(insetMaxX, insetMaxY));
  }
  const spacingX = tileW - 2 * insetX;
  const spacingY = tileH - 2 * insetY;
  const magnetDepth = Math.min(params.magnetDepth, baseThickness - FLOOR_MIN);
  const magnetFits =
    insetMin <= insetMaxX && insetMin <= insetMaxY && magnetDepth > 0;

  return {
    params,
    matrix,
    count,
    m,
    bridgeEff,
    bridgeCapped,
    bridgeFull,
    bridgeWidth: params.bridgeWidth, // surfaced for the readout (params is stripped)
    connectDiagonals: params.connectDiagonals,
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
    insetX,
    insetY,
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

  // ---- color-2 (dark) drawings, kept SEPARATE so each can be exported as its
  // own named STEP body (Tile / QR Code / Frame / Label). They don't overlap:
  // modules sit inside the quiet zone, the frame outside it, the label on the
  // panel — so no booleans are needed between them. ----
  const rects = mergeRects(matrix);
  // Modules + diagonal bridges go through ONE polygon-clipping union so the QR
  // body is robust and sliver-free. Bridges weld diagonally-touching modules
  // into a manifold, printable region. Dominates the build → maps to 0.05 .. 0.55.
  let polys = modulePolys(rects, m, qrLeft, qrTop);
  if (params.connectDiagonals && L.bridgeEff > 0) {
    polys = polys.concat(bridgePolys(matrix, m, qrLeft, qrTop, L.bridgeEff));
  }
  const modules2d = unionToDrawing(polys, (i, total) =>
    report(0.05 + 0.5 * (i / total), "modules")
  );

  let frame2d = null;
  if (params.frame && fw > 0) {
    report(0.58, "frame");
    frame2d = maskedRect(tileW, tileH, cornerR, params.corners).cut(
      maskedRect(tileW - 2 * fw, tileH - 2 * fw, innerR, params.corners)
    );
  }

  // Label-panel content (SVG image or rendered text, both delivered as polygon
  // shapes). Kept as its OWN drawing so a problem glyph can't corrupt the other
  // bodies — extruded with a fallback below.
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

  // (drawing, name) pairs for every present color-2 body.
  const darkDefs = [
    [modules2d, "QR Code"],
    [frame2d, "Frame"],
    [content2d, "Label"],
  ].filter(([d]) => d);

  const extrudeAt = (d, height, z) =>
    d.sketchOnPlane().extrude(height).translate([0, 0, z]);

  // Subtract the chamfered magnet pockets from a (light) solid.
  const cutMagnets = (solid) => {
    if (!(params.magnets && L.magnetFits)) return solid;
    const hx = tileW / 2 - L.insetX;
    const hy = tileH / 2 - L.insetY;
    let s = solid;
    [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].forEach(([sx, sy], k) => {
      const tool = magnetTool(L.holeR, CHAMFER, L.magnetDepth).translate([
        sx * hx,
        sy * hy,
        0,
      ]);
      s = s.cut(tool);
      report(0.78 + 0.07 * ((k + 1) / 4), "magnets");
    });
    return s;
  };

  // Assemble each body for the given print mode. If panel content makes the
  // kernel fail anywhere downstream, the worker rebuilds this model with content
  // stripped (panelContent "blank") — so resilience lives there, not here.
  const bodies = [];
  if (params.printMode === "flat") {
    // Flat: dark bodies are thin color inlays set into the TOP of the plate; the
    // solid base below stays light and houses the magnets.
    report(0.62, "plate");
    let plate = plate2d.sketchOnPlane().extrude(baseThickness);
    report(0.7, "shape");
    const z = baseThickness - inlayDepth;
    // Cut each dark footprint from the plate top. The dark drawings are disjoint
    // (modules inside the quiet zone, frame outside, label on the panel), so we
    // cut them one at a time as 3D solids — a robust OCCT boolean — instead of
    // fusing the 2D drawings into a single tool first: replicad's 2D blueprint
    // fuse is fragile on the complex module/label/frame outlines and would abort
    // ("24"). Each tool OVERSHOOTS the top face by 0.02 mm so a coplanar
    // tool/plate top doesn't leave zero-area faces that crash meshing.
    for (const [d] of darkDefs)
      plate = plate.cut(extrudeAt(d.clone(), inlayDepth + 0.02, z));
    plate = cutMagnets(plate);
    bodies.push({ shape: plate, name: "Tile", colorKey: "light" });
    for (const [d, name] of darkDefs)
      bodies.push({ shape: extrudeAt(d, inlayDepth, z), name, colorKey: "dark" });
  } else {
    // Raised: solid plate, dark bodies sit +blockHeight on top.
    report(0.62, "plate");
    let plate = plate2d.sketchOnPlane().extrude(baseThickness);
    plate = cutMagnets(plate);
    report(0.7, "shape");
    bodies.push({ shape: plate, name: "Tile", colorKey: "light" });
    for (const [d, name] of darkDefs)
      bodies.push({
        shape: extrudeAt(d, params.blockHeight, baseThickness),
        name,
        colorKey: "dark",
      });
  }

  return { bodies, layout: L };
}

/** Mesh every body for the three.js preview (called in the worker). The mesh
 * `name` is the colour key ("light"/"dark") so the UI material lookup is by
 * colour, not by part — several dark bodies just all render dark. */
export function meshModel({ bodies }, report = () => {}) {
  const shapes = [];
  bodies.forEach((b, i) => {
    report(0.86 + 0.13 * (i / bodies.length), "mesh");
    try {
      shapes.push({
        name: b.colorKey,
        faces: b.shape.mesh(),
        edges: b.shape.meshEdges(),
      });
    } catch (e) {
      // Localize the failure so the error names the body, not just "mesh".
      throw new Error(`mesh failed on ${b.name} body (${e?.message ?? e})`);
    }
  });
  report(0.99, "mesh");
  return shapes;
}

// STEP/STL export colours for the two filaments (also written into the STEP so
// slicers can auto-map by colour). Mirrors the preview materials in main.js.
const EXPORT_COLOR = { light: "#e8e8e8", dark: "#1c1c1c" };

// Clone so repeated exports (e.g. STEP then STL) don't consume the stored shapes.
const fuseAll = (shapes) =>
  shapes.reduce((acc, s) => (acc ? acc.fuse(s.clone()) : s.clone()), null);

/**
 * STEP export.
 * - Flat: each body is exported as its own NAMED, coloured solid (Tile / QR Code
 *   / Frame / Label) so the slicer shows meaningful, separately-assignable parts.
 * - Raised: the two colours differ only by height, so we fuse everything into ONE
 *   editable solid (two-colour printing via a slicer colour-change at the module
 *   height); names/colours don't apply.
 */
export function exportSTEPBlob({ bodies, layout }) {
  if (!bodies?.length) return null;
  if (layout?.params?.printMode === "raised")
    return fuseAll(bodies.map((b) => b.shape)).blobSTEP();
  return exportSTEP(
    bodies.map((b) => ({
      shape: b.shape.clone(),
      name: b.name,
      color: EXPORT_COLOR[b.colorKey],
    }))
  );
}

/** STL export — a plain mesh, so no names/colours: one fused solid in raised, a
 * multi-solid compound in flat. */
export function exportSTLBlob({ bodies, layout }) {
  if (!bodies?.length) return null;
  if (layout?.params?.printMode === "raised")
    return fuseAll(bodies.map((b) => b.shape)).blobSTL();
  return makeCompound(bodies.map((b) => b.shape.clone())).blobSTL();
}
