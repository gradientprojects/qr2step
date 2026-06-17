// Web Worker: owns the OpenCASCADE WASM instance and does all the heavy CAD
// work off the main thread. Exposed to the UI via comlink.
import { expose } from "comlink";
import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC } from "replicad";
import { buildModel, meshModel, exportSTEPBlob, exportSTLBlob } from "./model.js";

let ready = null;

async function init() {
  if (!ready) {
    ready = (async () => {
      const oc = await opencascade({ locateFile: () => opencascadeWasm });
      setOC(oc);
    })();
  }
  return ready;
}

// Keep the last built model around so export doesn't rebuild from scratch.
let current = null;

// Forward progress to the main thread, throttled to ~1% steps (or whenever the
// label changes) so we don't flood postMessage during the fuse loop.
function throttleProgress(fn) {
  let last = -1;
  let lastLabel = "";
  return (frac, label) => {
    if (!fn) return;
    if (frac >= 1 || label !== lastLabel || frac - last >= 0.01) {
      last = frac;
      lastLabel = label;
      try {
        fn(Math.min(1, frac), label);
      } catch {
        /* main thread went away */
      }
    }
  };
}

async function build(params, onProgress) {
  await init();
  const report = throttleProgress(onProgress);
  report(0.01, "read");
  current = buildModel(params, report); // reports up to 0.85
  const shapes = meshModel(current, report); // 0.85 .. 0.99
  report(1, "done");
  return { shapes, layout: serializeLayout(current.layout) };
}

// Strip the heavy replicad objects from the layout before sending to the UI.
function serializeLayout(L) {
  const { params, matrix, ...rest } = L;
  return rest;
}

async function exportSTEP() {
  if (!current) return null;
  return exportSTEPBlob(current);
}

async function exportSTL() {
  if (!current) return null;
  return exportSTLBlob(current);
}

expose({ build, exportSTEP, exportSTL });
