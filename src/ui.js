// Builds the control panel and reads parameter values back out of the DOM.
// Kept declarative so adding a knob is a one-line schema edit.

const FIELDS = [
  { group: "Content" },
  { name: "text", label: "URL / text", type: "text", value: "https://example.com" },
  {
    name: "ecLevel",
    label: "Error correction",
    type: "select",
    value: "M",
    options: [
      ["L", "L — low"],
      ["M", "M — medium (default)"],
      ["Q", "Q — quartile"],
      ["H", "H — high"],
    ],
    tip: "Higher = denser grid but more robust; needed for a center logo later.",
  },

  { group: "Print mode" },
  {
    name: "printMode",
    label: "Mode",
    type: "select",
    value: "raised",
    options: [
      ["raised", "Raised — modules stand proud"],
      ["flat", "Flat — best for dual-nozzle / multi-material"],
    ],
    tip: "Raised: modules stand proud of the plate by the block height — single-nozzle friendly (shadow or a color change at height). Flat: modules sit flush with the plate, color-only contrast — best for dual-nozzle / multi-material and the cleanest scan.",
  },

  { group: "Dimensions" },
  { name: "qrSize", label: "QR area size", type: "number", value: 40, min: 10, max: 200, step: 1, unit: "mm", tip: "Size of the scannable code area itself (not the whole tile)." },
  { type: "info", id: "readout-qrpanel", label: "QR + quiet zone", tip: "QR area plus the required light quiet-zone border on all sides." },
  { name: "cornerRadius", label: "Corner radius", type: "number", value: 2, min: 0, max: 15, step: 0.5, unit: "mm", tip: "Outer edge only; modules are never rounded." },
  { name: "baseThickness", label: "Base thickness", type: "number", value: 3, min: 1, max: 10, step: 0.2, unit: "mm", tip: "Auto-raised if the magnet depth would need it." },
  { name: "blockHeight", label: "Block height", type: "number", value: 1, min: 0.2, max: 5, step: 0.2, unit: "mm", tip: "Height the modules stand above the plate. Hidden in Flat mode.", showWhen: (p) => p.printMode !== "flat" },
  { name: "flatInlayDepth", label: "Color inlay depth", type: "number", value: 1.0, min: 0.4, max: 3, step: 0.1, unit: "mm", tip: "Flat mode: how deep the colored top layer is set into the plate. ~0.8–1.2 mm gives good opacity; the solid base below carries the magnets.", showWhen: (p) => p.printMode === "flat" },

  { group: "Layout" },
  { name: "quietModules", label: "Quiet-zone border", type: "number", value: 4, min: 4, max: 12, step: 1, unit: "modules", tip: "Hard minimum 4 — required for reliable scanning." },
  { name: "frame", label: "Outer frame", type: "checkbox", value: true },
  { name: "frameWidth", label: "Frame width", type: "number", value: 3, min: 0.5, max: 15, step: 0.5, unit: "mm", showWhen: (p) => p.frame },
  { name: "connectDiagonals", label: "Connect diagonal modules", type: "checkbox", value: false, tip: "Bridges diagonally-touching modules with a sliver of material. Removes non-manifold corner points so the model imports cleanly into CAD and prints as one connected piece. Strongly recommended." },
  { name: "bridgeWidth", label: "Bridge width", type: "number", value: 0.45, min: 0.1, max: 1, step: 0.05, unit: "mm", tip: "Target connector width. Default 0.45 mm = standard extrusion width for a 0.4 mm nozzle. Auto-capped to ⅓ of a module on dense codes so it never hurts scanning.", showWhen: (p) => p.connectDiagonals },
  { type: "info", id: "readout-bridge", label: "Bridge (effective)", tip: "Actual connector width after the ⅓-module scannability cap.", showWhen: (p) => p.connectDiagonals },

  { group: "Label panel" },
  {
    name: "panelSide",
    label: "Panel side",
    type: "select",
    value: "none",
    options: [
      ["none", "None"],
      ["bottom", "Bottom"],
      ["top", "Top"],
      ["left", "Left"],
      ["right", "Right"],
    ],
    tip: "Adds plate area outside the QR quiet zone (scan-safe). Text/SVG coming next; blank panel works now.",
  },
  {
    name: "panelContent",
    label: "Panel content",
    type: "select",
    value: "blank",
    options: [
      ["blank", "Blank plate"],
      ["svg", "SVG image"],
    ],
    tip: "Blank = bare plate to model in CAD later. SVG = upload a vector image, extruded into the panel as the dark color. (Text coming soon.)",
    showWhen: (p) => p.panelSide !== "none",
  },
  { type: "action", name: "svgFile", label: "SVG file", buttonText: "Choose SVG…", showWhen: (p) => p.panelSide !== "none" && p.panelContent === "svg" },
  { name: "panelDepth", label: "Panel depth", type: "number", value: 10, min: 3, max: 100, step: 1, unit: "mm", showWhen: (p) => p.panelSide !== "none" },

  { group: "Magnets" },
  { name: "magnets", label: "Corner magnets (4)", type: "checkbox", value: false },
  { name: "magnetHoleId", label: "Hole ID", type: "number", value: 6.3, min: 2, max: 20, step: 0.1, unit: "mm", showWhen: (p) => p.magnets },
  { name: "magnetDepth", label: "Hole depth", type: "number", value: 3.3, min: 0.5, max: 8, step: 0.1, unit: "mm", tip: "Base thickness auto-raises to keep a ≥0.6 mm floor under the pocket.", showWhen: (p) => p.magnets },
  { name: "magnetInset", label: "Corner inset", type: "number", value: 6, min: 1, max: 40, step: 0.5, unit: "mm", tip: "Distance from outer edge to magnet centre. Auto-clamped so the pocket stays ≥1.5 mm from any edge.", showWhen: (p) => p.magnets },
];

const READOUTS = [
  ["readout-tile", "Total tile"],
  ["readout-modules", "QR modules"],
  ["readout-base", "Base thickness"],
  ["readout-spacing", "Magnet spacing (c-c)"],
];

export function buildControls(root, handlers) {
  root.innerHTML = "";

  const header = document.createElement("div");
  header.className = "panel-header";
  header.innerHTML = `<h1>qr2step</h1><p>URL → 3D-printable QR → <strong>STEP</strong></p>`;
  root.appendChild(header);

  for (const f of FIELDS) {
    if (f.group) {
      const h = document.createElement("h2");
      h.textContent = f.group;
      root.appendChild(h);
      continue;
    }
    root.appendChild(renderField(f, handlers.onChange));
  }

  // Live readouts.
  const ro = document.createElement("div");
  ro.className = "readouts";
  for (const [id, label] of READOUTS) {
    const row = document.createElement("div");
    row.className = "readout-row";
    row.innerHTML = `<span>${label}</span><span id="${id}" class="readout-val">—</span>`;
    ro.appendChild(row);
  }
  root.appendChild(ro);

  // Downloads.
  const dl = document.createElement("div");
  dl.className = "downloads";
  const step = button("Download STEP", "primary", handlers.onDownloadSTEP);
  const stl = button("Download STL", "", handlers.onDownloadSTL);
  dl.append(step, stl);
  root.appendChild(dl);

  // Settings export/import.
  const settings = document.createElement("div");
  settings.className = "downloads settings-row";
  const exp = button("Export settings", "small", handlers.onExportSettings);
  const imp = button("Import settings", "small", handlers.onImportSettings);
  settings.append(exp, imp);
  root.appendChild(settings);
}

// Compose a hover tooltip: the field's description plus its allowed range.
function tooltipFor(f) {
  const parts = [];
  if (f.tip) parts.push(f.tip);
  if (f.type === "number" && (f.min != null || f.max != null)) {
    const u = f.unit ? ` ${f.unit}` : "";
    const lo = f.min != null ? f.min : "–";
    const hi = f.max != null ? f.max : "–";
    parts.push(`Range: ${lo}–${hi}${u}`);
  }
  if (f.type === "checkbox") parts.push("Toggle on/off");
  // Each explanation on its own line, blank line between (native title supports \n).
  return parts.join("\n\n");
}

function renderField(f, onChange) {
  // Action row: a button + filename label (e.g. SVG upload). Wired up by main.
  if (f.type === "action") {
    const row = document.createElement("div");
    row.className = "field field-action";
    row.dataset.field = f.name;
    if (f.tip) row.title = f.tip;
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = f.label;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small";
    btn.id = "f-" + f.name;
    btn.textContent = f.buttonText || "Choose…";
    const name = document.createElement("span");
    name.className = "file-name";
    name.id = "f-" + f.name + "-name";
    name.textContent = "none";
    row.append(lab, btn, name);
    return row;
  }

  // Read-only info line (e.g. derived "QR + quiet zone" size).
  if (f.type === "info") {
    const row = document.createElement("div");
    row.className = "field field-info";
    row.dataset.field = f.id;
    if (f.tip) row.title = f.tip;
    row.innerHTML = `<span class="field-label"></span><span class="info-val" id="${f.id}">—</span>`;
    row.querySelector(".field-label").textContent = f.label;
    return row;
  }

  const wrap = document.createElement("label");
  wrap.className = "field field-" + f.type;
  wrap.dataset.field = f.name; // used for show/hide

  const tip = tooltipFor(f);
  if (tip) wrap.title = tip; // native hover tooltip over the whole field row

  const labelText = document.createElement("span");
  labelText.className = "field-label";
  labelText.textContent = f.label + (f.unit ? ` (${f.unit})` : "");
  if (tip) labelText.title = tip;

  let input;
  if (f.type === "select") {
    input = document.createElement("select");
    for (const [val, txt] of f.options) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = txt;
      if (val === f.value) opt.selected = true;
      input.appendChild(opt);
    }
  } else {
    input = document.createElement("input");
    input.type = f.type;
    if (f.type === "checkbox") input.checked = f.value;
    else input.value = f.value;
    if (f.min != null) input.min = f.min;
    if (f.max != null) input.max = f.max;
    if (f.step != null) input.step = f.step;
  }
  input.id = "f-" + f.name;
  input.dataset.name = f.name;
  input.dataset.kind = f.type;
  if (tip) input.title = tip;
  input.addEventListener("input", onChange);
  input.addEventListener("change", onChange);

  if (f.type === "checkbox") {
    wrap.classList.add("inline");
    wrap.append(input, labelText);
  } else {
    wrap.append(labelText, input);
  }
  return wrap;
}

function button(text, cls, onClick) {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = "btn " + cls;
  b.addEventListener("click", onClick);
  return b;
}

export function readParams() {
  const params = {};
  for (const f of FIELDS) {
    if (f.group || f.type === "info" || f.type === "action") continue;
    const el = document.getElementById("f-" + f.name);
    if (!el) continue;
    if (f.type === "checkbox") params[f.name] = el.checked;
    else if (f.type === "number") params[f.name] = parseFloat(el.value);
    else params[f.name] = el.value;
  }
  return params;
}

// Write a saved params object back into the controls (partial merge — unknown
// or missing keys are left at their current values).
export function setParams(params) {
  if (!params || typeof params !== "object") return;
  for (const f of FIELDS) {
    if (f.group || f.type === "info" || !(f.name in params)) continue;
    const el = document.getElementById("f-" + f.name);
    if (!el) continue;
    if (f.type === "checkbox") el.checked = !!params[f.name];
    else el.value = params[f.name];
  }
}

// Show/hide fields whose `showWhen` predicate depends on other fields.
export function applyVisibility() {
  const p = readParams();
  for (const f of FIELDS) {
    if (!f.showWhen) continue;
    const key = f.name || f.id; // info lines are keyed by id
    const el = document.querySelector(`.field[data-field="${key}"]`);
    if (el) el.hidden = !f.showWhen(p);
  }
}
