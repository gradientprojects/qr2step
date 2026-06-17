import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { syncGeometries } from "replicad-threejs-helper";
import { wrap, proxy } from "comlink";
import { parse as parseFont } from "opentype.js";
import polygonClipping from "polygon-clipping";
import { buildControls, readParams, applyVisibility, setParams } from "./ui.js";
import archivoBlackUrl from "./fonts/ArchivoBlack-Regular.ttf?url";
import antonUrl from "./fonts/Anton-Regular.ttf?url";
import spaceMonoUrl from "./fonts/SpaceMono-Bold.ttf?url";

// Bundled OFL fonts for the label panel (id → file URL).
const FONT_URLS = {
  archivoBlack: archivoBlackUrl,
  anton: antonUrl,
  spaceMono: spaceMonoUrl,
};

// ---- worker ----
// A kernel abort (the bare-number errors like "24") can corrupt the OpenCASCADE
// WASM instance, so retries must run on a FRESH worker — we recreate it between
// fallback attempts rather than reusing the poisoned one.
let worker;
let api;
function spawnWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  api = wrap(worker);
}
spawnWorker();

// Below this printed-module size, modules lose definition and contrast (≈2× a
// 0.4 mm nozzle). Flag it so the user bumps QR area size or lowers EC.
const MODULE_MIN = 0.8; // mm

// ---- diagnostics: rolling event log for bug reports ----
const APP_VERSION = "1";
const eventLog = []; // { t, type, detail }
function logEvent(type, detail) {
  eventLog.push({ t: new Date().toISOString(), type, detail });
  if (eventLog.length > 40) eventLog.shift();
}
window.addEventListener("error", (e) =>
  logEvent("window-error", { message: String(e.message), source: e.filename })
);
window.addEventListener("unhandledrejection", (e) =>
  logEvent("unhandled-rejection", { reason: String(e.reason?.message ?? e.reason) })
);

// ---- three.js scene ----
const canvas = document.getElementById("three-canvas");
const statusEl = document.getElementById("status");
const panelEl = document.getElementById("buildsteps");
const panelTitle = panelEl.querySelector(".bs-title");
const panelPct = panelEl.querySelector(".bs-pct");
const panelBar = panelEl.querySelector(".bs-bar");
const panelList = panelEl.querySelector(".bs-list");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd9dde2);

// Two cameras: perspective for free 3D viewing, orthographic for the straight-on
// "normal" view (N) so the QR face reads true-to-scale with no perspective skew.
const perspCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
perspCamera.position.set(60, -90, 80);
perspCamera.up.set(0, 0, 1);
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 8000);
orthoCamera.up.set(0, 0, 1);
let camera = perspCamera; // active camera (swapped by setActiveCamera)

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = true;
controls.screenSpacePanning = true; // pan in the screen plane (intuitive for a flat tile)
// Onshape-style: middle-drag rotates, Ctrl+middle-drag pans, scroll zooms.
// OrbitControls has no modifier binding, so we flip the middle action while
// Ctrl is held. Left-drag also rotates (trackpad / no-middle-button fallback).
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.ROTATE,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN, // two-finger pinch-zoom + pan
};

function setMiddleAction(pan) {
  controls.mouseButtons.MIDDLE = pan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
}
window.addEventListener("keydown", (e) => {
  if (e.key === "Control") setMiddleAction(true);
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Control") setMiddleAction(false);
});
window.addEventListener("blur", () => setMiddleAction(false));

// Swap the active camera, carrying over position/up so the view doesn't jump.
function setActiveCamera(cam) {
  if (camera === cam) return;
  cam.position.copy(camera.position);
  cam.up.copy(camera.up);
  camera = cam;
  controls.object = cam;
  resize(); // recompute the new camera's projection for the current canvas
  controls.update();
}

// Straight-down "normal" view of the QR face in orthographic (no perspective),
// framed to the current tile.
let lastTile = { w: 80, h: 80 };
function setTopView() {
  setActiveCamera(orthoCamera);
  orthoCamera.zoom = 1;
  camera.up.set(0, 1, 0); // +Y is screen-up so the tile sits upright
  camera.position.set(0, 0, 1000); // distance is irrelevant for ortho scale
  controls.target.set(0, 0, 0);
  camera.lookAt(0, 0, 0);
  resize(); // frame the ortho frustum to the tile
  controls.update();
}

window.addEventListener("keydown", (e) => {
  // Ignore while typing in the URL/number fields.
  const t = document.activeElement?.tagName;
  if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
  if (e.key === "n" || e.key === "N") setTopView();
});

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.4);
dir.position.set(40, -60, 120);
scene.add(dir);

const materials = {
  light: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.85 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 }),
};
const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000 });

const modelGroup = new THREE.Group();
scene.add(modelGroup);
let geometries = [];

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  perspCamera.aspect = aspect;
  perspCamera.updateProjectionMatrix();
  // Ortho frustum framed to the current tile (with a little margin).
  const viewH = (Math.max(lastTile.w, lastTile.h) || 80) * 1.3;
  const viewW = viewH * aspect;
  orthoCamera.top = viewH / 2;
  orthoCamera.bottom = -viewH / 2;
  orthoCamera.left = -viewW / 2;
  orthoCamera.right = viewW / 2;
  orthoCamera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

function animate() {
  requestAnimationFrame(animate);
  if (!panelEl.hidden) tickBar();
  controls.update();
  renderer.render(scene, camera);
}

function clearModel() {
  modelGroup.clear();
  geometries.forEach((g) => {
    g.faces?.dispose?.();
    g.lines?.dispose?.();
  });
  geometries = [];
}

function showModel(shapes) {
  clearModel();
  geometries = syncGeometries(shapes, []);
  for (const g of geometries) {
    const mat = materials[g.name] ?? materials.dark;
    modelGroup.add(new THREE.Mesh(g.faces, mat));
    modelGroup.add(new THREE.LineSegments(g.lines, edgeMat));
  }
}

// ---- build-steps panel ----
// Canonical step order; ids match what the worker/model emit. Some steps are
// conditional (frame/magnets), and "shape" is labelled by print mode.
const STEP_DEFS = [
  { id: "modules", label: () => "Build QR modules" },
  { id: "frame", label: () => "Add outer frame", applies: (p) => p.frame },
  { id: "panel", label: (p) => (p.panelContent === "text" ? "Build panel text" : "Build panel SVG"), applies: (p) => p.panelSide !== "none" && (p.panelContent === "svg" || p.panelContent === "text") },
  { id: "plate", label: () => "Extrude base plate" },
  {
    id: "shape",
    label: (p) => (p.printMode === "flat" ? "Carve modules (flat)" : "Raise modules"),
  },
  { id: "magnets", label: () => "Cut magnet pockets", applies: (p) => p.magnets },
  { id: "mesh", label: () => "Mesh preview" },
];
const STEP_ORDER = ["load", ...STEP_DEFS.map((s) => s.id), "export"];

let engineReady = false;
let panelHideTimer = null;

function buildStepList(params) {
  const steps = STEP_DEFS.filter((s) => !s.applies || s.applies(params)).map((s) => ({
    id: s.id,
    label: s.label(params),
  }));
  // The first build also loads the multi-MB CAD engine — surface that.
  if (!engineReady) steps.unshift({ id: "load", label: "Load CAD engine" });
  return steps;
}

function showPanel(title, steps) {
  clearTimeout(panelHideTimer);
  panelEl.hidden = false;
  panelEl.classList.remove("error", "indeterminate");
  panelTitle.textContent = title;
  setOverall(0);
  panelList.innerHTML = "";
  for (const s of steps) {
    const li = document.createElement("li");
    li.className = "bs-step is-pending";
    li.dataset.id = s.id;
    li.innerHTML = `<span class="bs-icon"></span><span class="bs-step-label"></span>`;
    li.querySelector(".bs-step-label").textContent = s.label;
    panelList.appendChild(li);
  }
}

function setActiveStep(id) {
  const rank = STEP_ORDER.indexOf(id);
  for (const li of panelList.children) {
    const r = STEP_ORDER.indexOf(li.dataset.id);
    li.classList.toggle("is-done", r > -1 && r < rank);
    li.classList.toggle("is-active", r === rank);
    li.classList.toggle("is-pending", r > rank);
  }
}

function completeAllSteps() {
  for (const li of panelList.children) {
    li.classList.remove("is-active", "is-pending");
    li.classList.add("is-done");
  }
}

// The bar eases toward the last reported checkpoint, then creeps slowly toward a
// soft ceiling above it — so during a long kernel op (boolean/mesh) that reports
// nothing, the bar keeps moving instead of freezing, reading as elapsed time
// rather than discrete step jumps. tickBar() runs every animation frame.
let barShown = 0;
let barTarget = 0;
let barCreep = 0;
let barIndeterminate = false;

function setOverall(frac) {
  panelEl.classList.remove("indeterminate");
  barIndeterminate = false;
  barTarget = Math.max(0, Math.min(1, frac));
  barCreep = Math.min(0.985, barTarget + 0.12);
  if (barTarget < barShown) barShown = barTarget; // new build / reset snaps down
}

function tickBar() {
  if (barIndeterminate) return;
  const easingToTarget = barShown < barTarget;
  const goal = easingToTarget ? barTarget : barCreep;
  const speed = easingToTarget ? 0.2 : 0.015; // snap to checkpoints, creep slowly
  barShown += (goal - barShown) * speed;
  const pct = Math.max(0, Math.min(1, barShown));
  panelBar.style.width = pct * 100 + "%";
  panelPct.textContent = Math.round(pct * 100) + "%";
}

function setIndeterminateOverall() {
  panelEl.classList.add("indeterminate");
  barIndeterminate = true;
  panelBar.style.width = "";
  panelPct.textContent = "";
}

function hidePanel(delay = 0) {
  clearTimeout(panelHideTimer);
  panelHideTimer = setTimeout(() => (panelEl.hidden = true), delay);
}

function panelError(msg) {
  panelEl.classList.add("error");
  panelEl.classList.remove("indeterminate");
  panelTitle.textContent = msg;
}

// ---- SVG upload (parsed on the main thread; geometry built in the worker) ----
let svgData = null; // { shapes:[{outer,holes}], bounds:{minX,minY,maxX,maxY} }

// Signed area of a ring (shoelace). Sign encodes winding direction.
function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function closeRing(r) {
  const f = r[0];
  const l = r[r.length - 1];
  return f[0] === l[0] && f[1] === l[1] ? r : [...r, f];
}

// Resolve a set of raw contours (font glyphs / SVG paths) into clean polygons
// with proper holes, using a nonzero-winding union/difference. This fixes
// overlapping and self-intersecting contours (common in OTF/CFF fonts) that
// would otherwise extrude into an invalid solid and crash the CAD kernel.
function cleanContours(contours) {
  const rings = contours.filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-6);
  if (!rings.length) return null;
  // The largest-area contour is always a filled outer; its winding is "fill".
  let maxAbs = 0;
  let fillSign = 1;
  for (const r of rings) {
    const a = ringArea(r);
    if (Math.abs(a) > maxAbs) { maxAbs = Math.abs(a); fillSign = Math.sign(a); }
  }
  const fills = rings.filter((r) => Math.sign(ringArea(r)) === fillSign).map((r) => [closeRing(r)]);
  const holes = rings.filter((r) => Math.sign(ringArea(r)) !== fillSign).map((r) => [closeRing(r)]);
  let multi;
  try {
    multi = fills.length ? polygonClipping.union(...fills) : [];
    if (holes.length && multi.length) multi = polygonClipping.difference(multi, ...holes);
  } catch {
    return null; // cleaning failed → caller drops the content (with a warning)
  }
  const shapes = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of multi) {
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    for (const [x, y] of outer) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    shapes.push({ outer, holes: poly.slice(1) });
  }
  if (!shapes.length) return null;
  return { shapes, bounds: { minX, minY, maxX, maxY } };
}

function parseSvg(text) {
  const data = new SVGLoader().parse(text);
  const contours = [];
  for (const path of data.paths) {
    for (const sub of path.subPaths) {
      const pts = sub.getPoints(16); // tessellate curves
      if (pts.length >= 3) contours.push(pts.map((p) => [p.x, -p.y])); // SVG y down → model y up
    }
  }
  return cleanContours(contours);
}

// ---- panel text → outline shapes ----
const fontCache = new Map(); // id → parsed opentype.Font
let uploadedFont = null; // user-uploaded opentype.Font (stays in-browser)

async function loadFont(choice) {
  // User font: kept in memory only, never fetched. Falls back if none uploaded.
  if (choice === "uploaded") return uploadedFont || loadFont("archivoBlack");
  if (fontCache.has(choice)) return fontCache.get(choice);
  const url = FONT_URLS[choice] || FONT_URLS.archivoBlack;
  const buf = await fetch(url).then((r) => r.arrayBuffer());
  const font = parseFont(buf);
  fontCache.set(choice, font);
  return font;
}

// Tessellate opentype path commands into flat contours (model y-up). Quadratics
// and cubics are flattened to line segments. px/py track the FLIPPED pen so the
// segment math stays consistent with the emitted points.
function flattenCommands(commands) {
  const STEPS = 12;
  const contours = [];
  let cur = null;
  let px = 0;
  let py = 0;
  const quad = (x1, y1, x, y) => {
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS, mt = 1 - t;
      cur.push([mt * mt * px + 2 * mt * t * x1 + t * t * x, mt * mt * py + 2 * mt * t * y1 + t * t * y]);
    }
    px = x; py = y;
  };
  const cube = (x1, y1, x2, y2, x, y) => {
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS, mt = 1 - t;
      cur.push([
        mt * mt * mt * px + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x,
        mt * mt * mt * py + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y,
      ]);
    }
    px = x; py = y;
  };
  for (const c of commands) {
    if (c.type === "M") { if (cur && cur.length >= 3) contours.push(cur); cur = [[c.x, -c.y]]; px = c.x; py = -c.y; }
    else if (c.type === "L") { cur.push([c.x, -c.y]); px = c.x; py = -c.y; }
    else if (c.type === "Q") quad(c.x1, -c.y1, c.x, -c.y);
    else if (c.type === "C") cube(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
    else if (c.type === "Z") { if (cur && cur.length >= 3) contours.push(cur); cur = null; }
  }
  if (cur && cur.length >= 3) contours.push(cur);
  return contours;
}

// Convert a string to the same {shapes, bounds} format parseSvg() returns. We
// lay out glyphs ourselves (charToGlyph + advanceWidth) instead of
// font.getPath(string): opentype.js 2.x runs a shaping engine on whole strings
// that throws on some fonts' OpenType features (e.g. Space Mono's ccmp). Per-
// glyph tessellation sidesteps that and the SVGLoader round-trip entirely.
function textToSvgData(font, text) {
  const fontSize = 100; // arbitrary em size; scaled to fit the panel later
  const scale = fontSize / font.unitsPerEm;
  let x = 0;
  const commands = [];
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    commands.push(...glyph.getPath(x, 0, fontSize).commands);
    x += (glyph.advanceWidth || 0) * scale;
  }
  return cleanContours(flattenCommands(commands));
}

// Resolve panel content into svgShapes/svgBounds (+ target height for text) so
// the model can extrude it. Returns the (mutated) params.
async function prepareContent(params) {
  if (params.panelSide === "none") return params;
  if (params.panelContent === "svg" && svgData) {
    params.svgShapes = svgData.shapes;
    params.svgBounds = svgData.bounds;
  } else if (params.panelContent === "text" && params.panelText?.trim()) {
    const font = await loadFont(params.fontChoice);
    const data = textToSvgData(font, params.panelText.trim());
    if (data) {
      params.svgShapes = data.shapes;
      params.svgBounds = data.bounds;
      params.svgTargetHeight = params.textHeight;
    }
  }
  return params;
}

// ---- build pipeline (debounced) ----
let building = false;
let queued = false;

// "Uploaded font" is selected but none is loaded yet (e.g. just picked the
// option, or reloaded — the font lives only in memory). Don't build with a
// silent fallback; wait for the upload.
function awaitingFontUpload(params) {
  return (
    params.panelSide !== "none" &&
    params.panelContent === "text" &&
    params.fontChoice === "uploaded" &&
    !uploadedFont
  );
}

async function regenerate() {
  if (building) {
    queued = true;
    return;
  }
  if (awaitingFontUpload(readParams())) {
    hidePanel();
    setStatus('Upload a font to render the panel text (use "Upload font…").', false, false);
    return;
  }
  building = true;
  const params = readParams();
  await prepareContent(params);
  showPanel("Building", buildStepList(params));
  setStatus("");
  let lastStep = "read";
  try {
    const onProgress = proxy((frac, id) => {
      setOverall(frac);
      if (id && id !== "done" && id !== "read") {
        lastStep = id;
        setActiveStep(id);
      }
    });
    const { shapes, layout } = await api.build(params, onProgress);
    showModel(shapes);
    updateReadouts(layout);
    engineReady = true;
    completeAllSteps();
    setOverall(1);
    hidePanel(600);
  } catch (err) {
    // Fail fast with context — don't silently retry. A kernel abort can poison
    // the WASM instance, so recreate the worker once for the NEXT build.
    console.error(err);
    const msg = String(err?.message ?? err);
    const context = {
      step: lastStep,
      mode: params.printMode,
      panel: params.panelSide,
      content: params.panelContent,
      font: params.fontChoice,
      magnets: params.magnets,
    };
    logEvent("build-failed", { error: msg, context });
    panelError(`Build failed at "${lastStep}" (${msg}) — see Export log for details.`);
    spawnWorker();
  } finally {
    building = false;
    if (queued) {
      queued = false;
      regenerate();
    }
  }
}

let debounceTimer = null;
function scheduleRegen() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(regenerate, 250);
}

function setStatus(msg, busy = false, error = false) {
  statusEl.textContent = msg;
  statusEl.style.display = msg ? "block" : "none";
  statusEl.classList.toggle("busy", busy);
  statusEl.classList.toggle("error", error);
}

function updateReadouts(layout) {
  const set = (id, txt) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  set("readout-qrpanel", `${layout.tileW.toFixed(1)} × ${layout.tileH.toFixed(1)} mm`);
  set(
    "readout-bridge",
    `${layout.bridgeEff.toFixed(2)} mm${layout.bridgeCapped ? " (capped)" : ""}`
  );
  lastTile = { w: layout.tileW, h: layout.tileH };
  updateFilenameReadout();
  set("readout-modules", `${layout.count} × ${layout.count}`);
  const mEl = document.getElementById("readout-module-size");
  if (mEl) {
    const tooSmall = layout.m < MODULE_MIN;
    mEl.textContent = `${layout.m.toFixed(2)} mm${tooSmall ? " ⚠ too small for clean print/scan" : ""}`;
    mEl.classList.toggle("warn", tooSmall);
  }
  set(
    "readout-base",
    `${layout.baseThickness.toFixed(1)} mm${layout.baseRaised ? " ↑ for magnets" : ""}`
  );
  set("readout-spacing", `${layout.spacingX.toFixed(1)} × ${layout.spacingY.toFixed(1)} mm`);
  if (!layout.magnetFits) set("readout-spacing", "magnet won't fit — adjust ID/size");
}

// ---- export file naming ----
// Slug a URL/string into a safe filename base: drop the scheme + www, lowercase,
// keep [a-z0-9_], turn everything else into single dashes, cap length.
function slugify(text) {
  let s = (text || "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, "");
  return s || "qrcode";
}

// Content-derived base, or the user's override (also slugged).
function baseName(p) {
  const o = p.exportName?.trim();
  return slugify(o || p.text);
}

// Full model stem: base + tile size + EC level + print mode (+ -mag). The build
// variants (size/mode) keep flat vs raised vs resized exports from colliding.
function modelStem(p) {
  return (
    `${baseName(p)}` +
    `-${Math.round(lastTile.w)}x${Math.round(lastTile.h)}mm` +
    `-ec${p.ecLevel}` +
    `-${p.printMode}` +
    (p.magnets ? "-mag" : "")
  );
}

// Reflect the resolved export name in the sidebar so it's never a surprise.
function updateFilenameReadout() {
  const el = document.getElementById("readout-filename");
  if (el) el.textContent = `${modelStem(readParams())}.step / .stl`;
}

// ---- downloads ----
async function download(kind) {
  const K = kind.toUpperCase();
  // Export is a single serialization call — show one indeterminate step.
  showPanel(`Exporting ${K}`, [{ id: "export", label: `Write ${K} file` }]);
  setActiveStep("export");
  setIndeterminateOverall();
  try {
    const blob =
      kind === "step" ? await api.exportSTEP() : await api.exportSTL();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${modelStem(readParams())}.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
    completeAllSteps();
    setOverall(1);
    hidePanel(500);
  } catch (err) {
    console.error(err);
    panelError("Export failed: " + (err?.message ?? err));
  }
}

// ---- settings persistence (localStorage) + export/import ----
const LS_KEY = "qr2step.settings.v2";

function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(readParams()));
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) setParams(JSON.parse(raw));
  } catch {
    /* corrupt/blocked — fall back to defaults */
  }
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportSettings() {
  downloadJSON({ app: "qr2step", version: 1, params: readParams() }, `${baseName(readParams())}-settings.json`);
}

// Strip heavy/derived geometry from params so the report stays small + readable.
function scrubParams(params) {
  const { svgShapes, svgBounds, svgTargetHeight, ...rest } = params || {};
  return rest;
}

// A scrubbed diagnostics report for bug reports. Never includes uploaded font /
// SVG file bytes — only metadata that helps reproduce an issue.
function buildErrorReport() {
  const font = uploadedFont
    ? {
        name:
          uploadedFont.names?.fullName?.en ||
          uploadedFont.names?.fontFamily?.en ||
          "unknown",
        unitsPerEm: uploadedFont.unitsPerEm,
        numGlyphs: uploadedFont.numGlyphs,
        outlines: uploadedFont.outlinesFormat,
      }
    : null;
  return {
    app: "qr2step",
    version: APP_VERSION,
    generatedAt: new Date().toISOString(),
    engineReady,
    settings: scrubParams(readParams()),
    uploadedFont: font,
    svgLoaded: !!svgData,
    environment: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
    },
    events: eventLog,
  };
}

function exportLog() {
  downloadJSON(buildErrorReport(), "qr2step-error-log.json");
}

// Public GitHub repo that receives bug reports. Set this to the published repo
// (e.g. "owner/qr2step") to enable the "Report a bug" button; until then it
// falls back to downloading the log.
const ISSUES_REPO = "OWNER/REPO";

function submitErrorReport() {
  if (ISSUES_REPO.includes("OWNER")) {
    // Not configured yet — don't open a 404; give the user the file instead.
    exportLog();
    setStatus("Bug reporting isn't configured yet — exported the log instead.", false, true);
    return;
  }
  const report = buildErrorReport();
  // Keep the issue body within GitHub's URL length limit — trim the event log
  // and, if still long, truncate (the full report is available via Export log).
  let trimmed = { ...report, events: report.events.slice(-12) };
  let json = JSON.stringify(trimmed, null, 2);
  let truncated = false;
  if (json.length > 6000) {
    trimmed = { ...report, events: report.events.slice(-4) };
    json = JSON.stringify(trimmed, null, 2);
    if (json.length > 6000) { json = json.slice(0, 6000); truncated = true; }
  }
  const lastFail = [...report.events].reverse().find((e) => e.type === "build-failed");
  const title = lastFail ? `Build failed: ${lastFail.detail.error}` : "qr2step bug report";
  const body = [
    "**What happened?**",
    "<!-- Describe the problem. -->",
    "",
    "**What were you doing?**",
    "",
    "---",
    "<details><summary>Auto-captured diagnostics</summary>",
    "",
    "```json",
    json,
    "```",
    truncated ? "\n_(diagnostics truncated — use “Export log” and attach the full file.)_" : "",
    "</details>",
  ].join("\n");
  const url =
    `https://github.com/${ISSUES_REPO}/issues/new` +
    `?labels=bug&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  window.open(url, "_blank", "noopener");
}

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "application/json,.json";
fileInput.style.display = "none";
document.body.appendChild(fileInput);
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    setParams(data?.params ?? data); // accept {params} or a bare params object
    applyVisibility();
    saveSettings();
    regenerate();
  } catch {
    setStatus("Couldn't read that settings file", false, true);
  }
  fileInput.value = "";
});

// ---- boot ----
buildControls(document.getElementById("controls"), {
  onChange: (f) => {
    applyVisibility(); // hide fields that don't apply to current settings
    saveSettings(); // remember for next visit
    updateFilenameReadout(); // cheap; reflects the name instantly
    // The export name doesn't affect geometry — skip the OCCT rebuild for it.
    if (f?.name === "exportName") return;
    scheduleRegen();
  },
  onDownloadSTEP: () => download("step"),
  onDownloadSTL: () => download("stl"),
  onExportSettings: exportSettings,
  onImportSettings: () => fileInput.click(),
  onExportLog: exportLog,
  onSubmitLog: submitErrorReport,
});

// SVG upload wiring.
const svgInput = document.createElement("input");
svgInput.type = "file";
svgInput.accept = ".svg,image/svg+xml";
svgInput.style.display = "none";
document.body.appendChild(svgInput);
document.getElementById("f-svgFile")?.addEventListener("click", () => svgInput.click());
svgInput.addEventListener("change", async () => {
  const file = svgInput.files?.[0];
  if (!file) return;
  try {
    svgData = parseSvg(await file.text());
    const nameEl = document.getElementById("f-svgFile-name");
    if (nameEl) nameEl.textContent = svgData ? file.name : "no shapes found";
    regenerate();
  } catch {
    setStatus("Couldn't read that SVG", false, true);
  }
  svgInput.value = "";
});

// Font upload wiring. The file is parsed in-browser only — never uploaded.
const fontInput = document.createElement("input");
fontInput.type = "file";
fontInput.accept = ".ttf,.otf,font/ttf,font/otf";
fontInput.style.display = "none";
document.body.appendChild(fontInput);
document.getElementById("f-fontFile")?.addEventListener("click", () => fontInput.click());
fontInput.addEventListener("change", async () => {
  const file = fontInput.files?.[0];
  if (!file) return;
  try {
    uploadedFont = parseFont(await file.arrayBuffer());
    const nameEl = document.getElementById("f-fontFile-name");
    if (nameEl) nameEl.textContent = file.name;
    const sel = document.getElementById("f-fontChoice");
    if (sel) sel.value = "uploaded";
    logEvent("font-uploaded", { file: file.name, outlines: uploadedFont.outlinesFormat, unitsPerEm: uploadedFont.unitsPerEm });
    saveSettings();
    regenerate();
  } catch {
    uploadedFont = null;
    logEvent("font-upload-failed", { file: file.name });
    setStatus("Couldn't read that font file", false, true);
  }
  fontInput.value = "";
});

loadSettings(); // restore last-used settings, if any
applyVisibility();
resize();
animate();
regenerate();
