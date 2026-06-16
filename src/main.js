import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { syncGeometries } from "replicad-threejs-helper";
import { wrap, proxy } from "comlink";
import { buildControls, readParams, applyVisibility, setParams } from "./ui.js";

// ---- worker ----
const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});
const api = wrap(worker);

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

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
camera.position.set(60, -90, 80);
camera.up.set(0, 0, 1);

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

// Straight-down "normal" view of the QR face, framed to the current tile.
let lastTile = { w: 80, h: 80 };
function setTopView() {
  const maxDim = Math.max(lastTile.w, lastTile.h) || 80;
  const dist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 180 / 2) * 1.25;
  camera.up.set(0, 1, 0); // +Y is screen-up so the tile sits upright
  camera.position.set(0, 0, dist);
  controls.target.set(0, 0, 0);
  camera.lookAt(0, 0, 0);
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
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

function animate() {
  requestAnimationFrame(animate);
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
  { id: "panel", label: () => "Build panel SVG", applies: (p) => p.panelSide !== "none" && p.panelContent === "svg" },
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

function setOverall(frac) {
  panelEl.classList.remove("indeterminate");
  const pct = Math.max(0, Math.min(1, frac));
  panelBar.style.width = pct * 100 + "%";
  panelPct.textContent = Math.round(pct * 100) + "%";
}

function setIndeterminateOverall() {
  panelEl.classList.add("indeterminate");
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

function parseSvg(text) {
  const data = new SVGLoader().parse(text);
  const shapes = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of data.paths) {
    const shapeList = SVGLoader.createShapes(path);
    for (const shape of shapeList) {
      const pts = shape.extractPoints(12); // tessellate curves
      const flip = (p) => [p.x, -p.y]; // SVG y is down → model y is up
      const outer = pts.shape.map(flip);
      const holes = pts.holes.map((h) => h.map(flip));
      for (const [x, y] of outer) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      if (outer.length >= 3) shapes.push({ outer, holes });
    }
  }
  if (!shapes.length) return null;
  return { shapes, bounds: { minX, minY, maxX, maxY } };
}

// ---- build pipeline (debounced) ----
let building = false;
let queued = false;

async function regenerate() {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  const params = readParams();
  if (params.panelContent === "svg" && params.panelSide !== "none" && svgData) {
    params.svgShapes = svgData.shapes;
    params.svgBounds = svgData.bounds;
  }
  showPanel("Building", buildStepList(params));
  setStatus("");
  try {
    const onProgress = proxy((frac, id) => {
      setOverall(frac);
      if (id && id !== "done" && id !== "read") setActiveStep(id);
    });
    const { shapes, layout } = await api.build(params, onProgress);
    showModel(shapes);
    updateReadouts(layout);
    engineReady = true;
    completeAllSteps();
    setOverall(1);
    hidePanel(600);
  } catch (err) {
    console.error(err);
    panelError("Build failed: " + (err?.message ?? err));
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
  set("readout-qrpanel", `${layout.innerSide.toFixed(1)} × ${layout.innerSide.toFixed(1)} mm`);
  set(
    "readout-bridge",
    `${layout.bridgeEff.toFixed(2)} mm${layout.bridgeCapped ? " (capped)" : ""}`
  );
  lastTile = { w: layout.tileW, h: layout.tileH };
  set("readout-tile", `${layout.tileW.toFixed(1)} × ${layout.tileH.toFixed(1)} mm`);
  set("readout-modules", `${layout.count} × ${layout.count}`);
  set(
    "readout-base",
    `${layout.baseThickness.toFixed(1)} mm${layout.baseRaised ? " ↑ for magnets" : ""}`
  );
  set("readout-spacing", `${layout.spacingX.toFixed(1)} × ${layout.spacingY.toFixed(1)} mm`);
  if (!layout.magnetFits) set("readout-spacing", "magnet won't fit — adjust ID/size");
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
    a.download = `qr2step.${kind}`;
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
const LS_KEY = "qr2step.settings.v1";

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

function exportSettings() {
  const data = { app: "qr2step", version: 1, params: readParams() };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "qr2step-settings.json";
  a.click();
  URL.revokeObjectURL(url);
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
  onChange: () => {
    applyVisibility(); // hide fields that don't apply to current settings
    saveSettings(); // remember for next visit
    scheduleRegen();
  },
  onDownloadSTEP: () => download("step"),
  onDownloadSTL: () => download("stl"),
  onExportSettings: exportSettings,
  onImportSettings: () => fileInput.click(),
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

loadSettings(); // restore last-used settings, if any
applyVisibility();
resize();
animate();
regenerate();
