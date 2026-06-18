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
controls.enableDamping = true; // smooths wheel zoom + touch gestures
controls.zoomToCursor = true; // scroll-zoom toward the pointer, not the centre
// Ignore ALL mouse buttons (-1 = no action) so OrbitControls never acts on a
// mouse drag — mouse navigation is handled by the listeners below. Touch and
// wheel zoom stay with OrbitControls, so one-finger touch still rotates and
// two-finger still pans/zooms.
controls.mouseButtons = { LEFT: -1, MIDDLE: -1, RIGHT: -1 };
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN, // two-finger pinch-zoom + pan
};

// ---- mouse navigation (handled directly, not via OrbitControls) ----
// This avoids OrbitControls' button-map timing, event ordering, the macOS
// "Ctrl+click = right button" quirk, and pan damping:
//   left-drag / middle-drag → orbit around the point under the cursor
//   Ctrl+drag / right-drag  → pan (screen-space, undamped → as snappy as orbit)
//   scroll                  → zoom toward the cursor (OrbitControls)
// Ctrl/⌘ is the pan modifier. Touch (OrbitControls): one-finger rotate, two-finger pan/zoom.
const raycaster = new THREE.Raycaster();
let drag = null; // { mode: "orbit" | "pan", x, y, pivot }
const ROT_SPEED = 0.005; // radians per pixel

function pickPivot(e) {
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    ),
    camera
  );
  const hits = modelGroup.children.length
    ? raycaster.intersectObjects(modelGroup.children, true)
    : [];
  return (hits[0]?.point ?? controls.target).clone();
}

// Rigidly rotate the camera about the pivot — the pivot stays fixed on screen.
function orbitBy(pivot, dx, dy) {
  const up = camera.up.clone().normalize();
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(camera.quaternion)
    .normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  let polar = -dy * ROT_SPEED;
  // Stop short of the poles so the view never flips or rolls.
  const probe = forward
    .clone()
    .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(right, polar));
  const a = probe.angleTo(up);
  if (a < 0.05 || a > Math.PI - 0.05) polar = 0;
  const q = new THREE.Quaternion()
    .setFromAxisAngle(up, -dx * ROT_SPEED)
    .multiply(new THREE.Quaternion().setFromAxisAngle(right, polar));
  camera.position.sub(pivot).applyQuaternion(q).add(pivot);
  camera.quaternion.premultiply(q);
}

// Screen-space pan: translate camera + target so the scene tracks the cursor 1:1.
function panBy(dx, dy) {
  const h = canvas.clientHeight || 1;
  const worldPerPx = camera.isPerspectiveCamera
    ? (2 * camera.position.distanceTo(controls.target) *
        Math.tan(((camera.fov * Math.PI) / 180) / 2)) /
      h
    : (camera.top - camera.bottom) / camera.zoom / h;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
  const move = right
    .multiplyScalar(-dx * worldPerPx)
    .addScaledVector(up, dy * worldPerPx);
  camera.position.add(move);
  controls.target.add(move);
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button === 1) e.preventDefault(); // suppress middle-button autoscroll
});
// Clicking into the preview should take focus away from any sidebar field, so
// keyboard shortcuts (e.g. N for the normal view) work without an extra click.
canvas.addEventListener("pointerdown", () => {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) {
    a.blur();
  }
});
// Suppress the context menu so right-drag and macOS Ctrl+left-drag (which the OS
// delivers as a right-button context-click) aren't interrupted mid-drag.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "touch") return; // OrbitControls handles touch
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl/⌘ is the pan modifier: Ctrl+drag pans on any button. Plain left/middle
  // orbits; right always pans (incl. macOS Ctrl+left, delivered as right).
  let mode = null;
  if (e.button === 0) mode = mod ? "pan" : "orbit";
  else if (e.button === 1) mode = mod ? "pan" : "orbit";
  else if (e.button === 2) mode = "pan";
  if (!mode) return;
  e.preventDefault();
  drag = {
    mode,
    x: e.clientX,
    y: e.clientY,
    pivot: mode === "orbit" ? pickPivot(e) : null,
  };
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.mode === "orbit") orbitBy(drag.pivot, dx, dy);
  else panBy(dx, dy);
});
function endDrag() {
  if (!drag) return;
  if (drag.mode === "orbit") {
    // Park the OrbitControls target on the view axis (at the pivot's depth) so
    // wheel-zoom resumes with no re-aim.
    const forward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(camera.quaternion)
      .normalize();
    controls.target
      .copy(camera.position)
      .addScaledVector(forward, camera.position.distanceTo(drag.pivot));
  }
  drag = null;
  controls.update();
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

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
  if (!drag) controls.update(); // custom nav drives the camera directly while dragging
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
// Serialized params of the model currently on screen. A queued rebuild (or any
// no-op field event) whose params match this is skipped, so rapid clicks don't
// trigger a redundant rebuild after the in-flight one finishes. Busted to null
// on SVG/font upload (content that readParams() doesn't capture).
let lastBuiltKey = null;

// Undo/redo history of param snapshots, recorded at build-commit points (so they
// inherit the debounce coalescing). suppressHistory marks a build that is itself
// the result of an undo/redo, so applying history doesn't get recorded again.
const undoStack = [];
const redoStack = [];
let suppressHistory = false;

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
    setStatus('Choose a font file to render the panel text (use "Choose font file…").', false, false);
    return;
  }
  const params = readParams();
  // Nothing changed since the last successful build — don't rebuild the same
  // thing (catches a queued rebuild whose net change cancelled out).
  const key = JSON.stringify(params);
  if (key === lastBuiltKey) return;
  building = true;
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
    // Record the state we're leaving so it can be undone to (skip the very first
    // build, and skip builds that are themselves an undo/redo).
    if (!suppressHistory && lastBuiltKey !== null && lastBuiltKey !== key) {
      undoStack.push(lastBuiltKey);
      if (undoStack.length > 50) undoStack.shift();
      redoStack.length = 0; // a fresh edit invalidates the redo path
    }
    suppressHistory = false;
    lastBuiltKey = key; // mark this exact state as built (success only)
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
// Debounce the (expensive) OCCT rebuild so rapid input doesn't fire one per
// keystroke/click. Text gets a longer window than a click/toggle since you
// type many characters in a row.
function scheduleRegen(delay = 300) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(regenerate, delay);
}

// Apply a history snapshot (param string) without recording it as a new edit.
function applyHistoryState(stateStr) {
  suppressHistory = true;
  setParams(JSON.parse(stateStr));
  applyVisibility();
  saveSettings();
  updateFilenameReadout();
  regenerate();
}
function undo() {
  if (!undoStack.length) {
    setStatus("Nothing to undo");
    return;
  }
  redoStack.push(lastBuiltKey ?? JSON.stringify(readParams()));
  applyHistoryState(undoStack.pop());
}
function redo() {
  if (!redoStack.length) {
    setStatus("Nothing to redo");
    return;
  }
  undoStack.push(lastBuiltKey ?? JSON.stringify(readParams()));
  applyHistoryState(redoStack.pop());
}
// Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo. Skip when a textual field is
// focused so the field's own native text undo keeps working there.
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
  const t = e.target;
  const tag = t?.tagName;
  const textual =
    (tag === "INPUT" &&
      /^(text|number|search|url|email|tel|password)$/.test(t.type || "text")) ||
    tag === "TEXTAREA" ||
    t?.isContentEditable;
  if (textual) return;
  e.preventDefault();
  if (e.shiftKey) redo();
  else undo();
});

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
  // The "bridge used" line only earns its space when the requested width was
  // actually trimmed by the ⅓-module cap — otherwise effective == requested and
  // it's just noise. When capped, also surface the QR-area size that would lift
  // the cap, so the number is actionable rather than mysterious.
  const bridgeRow = document.querySelector('.field[data-field="readout-bridge"]');
  const bridgeCapped = layout.connectDiagonals && layout.bridgeCapped;
  if (bridgeRow) bridgeRow.hidden = !bridgeCapped;
  if (bridgeCapped) {
    set(
      "readout-bridge",
      `${layout.bridgeEff.toFixed(2)} mm · need ≥ ${Math.ceil(layout.bridgeFull)} mm QR area for ${layout.bridgeWidth.toFixed(2)}`
    );
  }
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
const ISSUES_REPO = "gradientprojects/qr2step";

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
    // Text inputs (URL, panel text) get a longer settle than clicks/toggles.
    scheduleRegen(f?.type === "text" ? 550 : 300);
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
    lastBuiltKey = null; // content changed but params didn't — force a rebuild
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
    lastBuiltKey = null; // content changed but params didn't — force a rebuild
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
