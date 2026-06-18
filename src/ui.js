// Builds the control panel and reads parameter values back out of the DOM.
// Kept declarative so adding a knob is a one-line schema edit.

const FIELDS = [
  { group: "Content" },
  { name: "text", label: "URL / text", type: "text", value: "https://example.com" },
  {
    name: "ecLevel",
    label: "Error correction",
    type: "select",
    value: "Q",
    options: [
      ["L", "L — low"],
      ["M", "M — medium"],
      ["Q", "Q — quartile (default)"],
      ["H", "H — high"],
    ],
    tip: "How much of the code can be recovered if it's damaged, dirty, or scuffed — L ~7%, M ~15%, Q ~25%, H ~30%. Higher = denser grid. Use L/M for clean on-screen or indoor codes; Q/H for printed labels that may wear, small prints, or anything mounted outdoors.",
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
  { name: "qrSize", label: "QR area size", type: "number", value: 40, min: 10, max: 200, step: 1, unit: "mm", tip: "Size of the scannable code area itself (not the whole tile).", rowGroup: "size" },
  { name: "quietModules", label: "Quiet-zone border", type: "number", value: 4, min: 4, max: 12, step: 1, unit: "modules", tip: "Hard minimum 4 — required for reliable scanning.", rowGroup: "size" },
  { name: "frame", label: "Outer frame", type: "checkbox", value: true },
  { name: "frameWidth", label: "Frame width", type: "number", value: 3, min: 0.5, max: 15, step: 0.5, unit: "mm", showWhen: (p) => p.frame, rowGroup: "frameround" },
  { name: "cornerRadius", label: "Corner radius", type: "number", value: 5, min: 0, max: 15, step: 0.5, unit: "mm", tip: "Outer edge only; modules are never rounded.", rowGroup: "frameround" },
  { name: "corners", label: "Corners", type: "corners", value: { tl: true, tr: true, bl: true, br: true }, tip: "Click a corner to toggle whether it gets the radius. Leave some square to butt the tile against other geometry in CAD.", showWhen: (p) => p.cornerRadius > 0, rowGroup: "frameround" },
  { name: "baseThickness", label: "Base thickness", type: "number", value: 3, min: 1, max: 10, step: 0.2, unit: "mm", tip: "Auto-raised if the magnet depth would need it." },
  { name: "blockHeight", label: "Block height", type: "number", value: 1, min: 0.2, max: 5, step: 0.2, unit: "mm", tip: "Height the modules stand above the plate. Hidden in Flat mode.", showWhen: (p) => p.printMode !== "flat" },
  { name: "flatInlayDepth", label: "Color inlay depth", type: "number", value: 1.0, min: 0.4, max: 3, step: 0.1, unit: "mm", tip: "Flat mode: how deep the colored top layer is set into the plate. ~0.8–1.2 mm gives good opacity; the solid base below carries the magnets.", showWhen: (p) => p.printMode === "flat" },

  { group: "Layout" },
  { name: "connectDiagonals", label: "Connect diagonal modules", type: "checkbox", value: true, tip: "Bridges diagonally-touching modules with a sliver of material. Removes non-manifold corner points so the model imports cleanly into CAD and prints as one connected piece. On by default — strongly recommended." },
  { name: "bridgeWidth", label: "Bridge width", type: "number", value: 0.45, min: 0.1, max: 1, step: 0.05, unit: "mm", tip: "Target connector width. Default 0.45 mm = standard extrusion width for a 0.4 mm nozzle. Auto-capped to ⅓ of a module on dense codes so it never hurts scanning.", showWhen: (p) => p.connectDiagonals },
  { type: "info", id: "readout-bridge", label: "Bridge capped", initHidden: true, tip: "The diagonal connector unavoidably pokes a little into the two neighbouring light cells, so it's limited to ⅓ of a module to protect scanning. Your bridge width is wider than that at this module size, so it was trimmed. Enlarge the QR area (shown) or lower the EC level to reach the full width." },

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
    rowGroup: "panel",
  },
  { name: "panelDepth", label: "Panel depth", type: "number", value: 10, min: 3, max: 100, step: 1, unit: "mm", showWhen: (p) => p.panelSide !== "none", rowGroup: "panel" },
  {
    name: "panelContent",
    label: "Panel content",
    type: "select",
    value: "text",
    options: [
      ["blank", "Blank"],
      ["text", "Text"],
      ["svg", "SVG"],
    ],
    tip: "Blank = bare plate to model in CAD later. Text = a string rendered in a bundled font. SVG = choose a local vector image. All are extruded into the panel as the dark color.",
    showWhen: (p) => p.panelSide !== "none",
    rowGroup: "panel",
  },
  { type: "action", name: "svgFile", label: "SVG file", buttonText: "Choose SVG…", showWhen: (p) => p.panelSide !== "none" && p.panelContent === "svg" },
  { name: "panelText", label: "Panel text", type: "text", value: "", tip: "The text rendered into the panel. Auto-shrinks to fit the panel width.", showWhen: (p) => p.panelSide !== "none" && p.panelContent === "text" },
  {
    name: "fontChoice",
    label: "Font",
    type: "select",
    value: "archivoBlack",
    options: [
      ["archivoBlack", "Archivo Black"],
      ["anton", "Anton"],
      ["spaceMono", "Space Mono"],
      ["uploaded", "Your own file"],
    ],
    tip: "Bundled bold fonts (all SIL Open Font License), or your own font file (read locally — never sent anywhere).",
    showWhen: (p) => p.panelSide !== "none" && p.panelContent === "text",
    rowGroup: "textopts",
  },
  { name: "textHeight", label: "Text height", type: "number", value: 6, min: 3, max: 50, step: 0.5, unit: "mm", tip: "Target height of the text. Flagged if it would fall below ~3 mm (gets hard to print/read).", showWhen: (p) => p.panelSide !== "none" && p.panelContent === "text", rowGroup: "textopts" },
  { type: "action", name: "fontFile", label: "Custom font", buttonText: "Choose font file…", note: "Read in your browser — the file is never sent anywhere; only its glyph outlines are baked into your downloaded STEP.", showWhen: (p) => p.panelSide !== "none" && p.panelContent === "text" && p.fontChoice === "uploaded" },
  {
    name: "alignH",
    label: "Horizontal align",
    type: "select",
    value: "center",
    options: [
      ["left", "Left"],
      ["center", "Center"],
      ["right", "Right"],
    ],
    tip: "Horizontal position of the text/SVG within the panel.",
    showWhen: (p) => p.panelSide !== "none" && (p.panelContent === "text" || p.panelContent === "svg"),
    rowGroup: "align",
  },
  {
    name: "alignV",
    label: "Vertical align",
    type: "select",
    value: "center",
    options: [
      ["top", "Top"],
      ["center", "Center"],
      ["bottom", "Bottom"],
    ],
    tip: "Vertical position of the text/SVG within the panel.",
    showWhen: (p) => p.panelSide !== "none" && (p.panelContent === "text" || p.panelContent === "svg"),
    rowGroup: "align",
  },

  { group: "Magnets" },
  { name: "magnets", label: "Corner magnets (4)", type: "checkbox", value: false },
  { name: "magnetHoleId", label: "Hole ID", type: "number", value: 6.3, min: 2, max: 20, step: 0.1, unit: "mm", showWhen: (p) => p.magnets },
  { name: "magnetDepth", label: "Hole depth", type: "number", value: 3.3, min: 0.5, max: 8, step: 0.1, unit: "mm", tip: "Base thickness auto-raises to keep a ≥0.6 mm floor under the pocket.", showWhen: (p) => p.magnets },
  {
    name: "magnetMode",
    label: "Position by",
    type: "select",
    value: "inset",
    options: [
      ["inset", "Inset from corner"],
      ["spacing", "XY pattern"],
    ],
    tip: "Inset from corner: one symmetric distance from each edge. XY pattern: independent centre-to-centre spacing in X and Y, to match a mounting jig or base.",
    showWhen: (p) => p.magnets,
  },
  { name: "magnetInset", label: "Corner inset", type: "number", value: 6, min: 1, max: 40, step: 0.5, unit: "mm", tip: "Distance from outer edge to magnet centre. Auto-clamped so the pocket stays ≥1.5 mm from any edge.", showWhen: (p) => p.magnets && p.magnetMode === "inset" },
  { name: "magnetSpacingX", label: "Spacing X", type: "number", value: 28, min: 0, step: 0.5, unit: "mm", tip: "Centre-to-centre distance between magnets across the width. Auto-clamped to keep ≥1.5 mm wall clearance.", showWhen: (p) => p.magnets && p.magnetMode === "spacing", rowGroup: "magspace" },
  { name: "magnetSpacingY", label: "Spacing Y", type: "number", value: 28, min: 0, step: 0.5, unit: "mm", tip: "Centre-to-centre distance between magnets across the height. Auto-clamped to keep ≥1.5 mm wall clearance.", showWhen: (p) => p.magnets && p.magnetMode === "spacing", rowGroup: "magspace" },

  { group: "Export" },
  { name: "exportName", label: "File name", type: "text", value: "", tip: "Leave blank to name files automatically from the QR content. Tile size, EC level, print mode, and magnets are appended — size/mode keep build variants from overwriting each other." },
  { type: "info", id: "readout-filename", label: "Saves as" },
];

const READOUTS = [
  ["readout-qrpanel", "External XY"],
  ["readout-modules", "QR modules"],
  ["readout-module-size", "Module size"],
  ["readout-base", "Base thickness"],
  ["readout-spacing", "Magnet spacing (c-c)"],
];

export function buildControls(root, handlers) {
  root.innerHTML = "";

  const header = document.createElement("div");
  header.className = "panel-header";
  const titleWrap = document.createElement("div");
  titleWrap.className = "panel-title";
  titleWrap.innerHTML = `<h1>qr2step</h1><p>URL → 3D-printable QR → <strong>STEP</strong> · <a href="https://github.com/gradientprojects/qr2step" target="_blank" rel="noopener">GitHub</a></p>`;
  const headerReset = button("Reset all", "small", () => {
    if (confirm("Reset all settings to their defaults?")) {
      resetGroup(); // no arg → every field
      handlers.onChange();
    }
  });
  headerReset.classList.add("header-reset");
  headerReset.title = "Reset every control to its default value.";
  header.append(titleWrap, headerReset);
  root.appendChild(header);

  for (let i = 0; i < FIELDS.length; i++) {
    const f = FIELDS[i];
    if (f.group) {
      const h = document.createElement("h2");
      h.className = "section-head";
      const label = document.createElement("span");
      label.textContent = f.group;
      const rb = document.createElement("button");
      rb.type = "button";
      rb.className = "section-reset";
      rb.textContent = "↺";
      rb.title = `Reset ${f.group} to defaults`;
      rb.addEventListener("click", () => {
        resetGroup(f.group);
        handlers.onChange();
      });
      h.append(label, rb);
      root.appendChild(h);
      continue;
    }
    // Consecutive fields sharing a rowGroup render side by side in one row.
    if (f.rowGroup) {
      const rowDiv = document.createElement("div");
      rowDiv.className = "field-row";
      let j = i;
      while (j < FIELDS.length && FIELDS[j].rowGroup === f.rowGroup) {
        rowDiv.appendChild(renderField(FIELDS[j], handlers.onChange));
        j++;
      }
      root.appendChild(rowDiv);
      i = j - 1;
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

  // Diagnostics: report a bug (opens a prefilled GitHub issue) or export the log.
  const diag = document.createElement("div");
  diag.className = "downloads settings-row";
  const reportBtn = button("Report a bug", "small", handlers.onSubmitLog);
  reportBtn.title = "Opens a prefilled GitHub issue with diagnostics (settings, recent errors, browser info). No font/SVG files are included — you review and submit it.";
  const logBtn = button("Export log", "small", handlers.onExportLog);
  logBtn.title = "Download the same diagnostics as a JSON file.";
  diag.append(reportBtn, logBtn);
  root.appendChild(diag);
}

// Compose a hover tooltip: the field's description plus its allowed range.
// Split a run-on tip into sentences so the native tooltip shows one per block.
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tooltipFor(f) {
  const parts = [];
  if (f.tip) parts.push(...splitSentences(f.tip));
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
    if (f.note) {
      const note = document.createElement("span");
      note.className = "field-note";
      note.textContent = f.note;
      row.appendChild(note);
    }
    return row;
  }

  // Corner picker: a 2×2 mini-tile, each corner a toggle for the radius.
  if (f.type === "corners") {
    const row = document.createElement("div");
    row.className = "field field-corners";
    row.dataset.field = f.name;
    if (f.tip) row.title = f.tip;
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = f.label;
    const grid = document.createElement("div");
    grid.className = "corner-grid";
    grid.id = "f-" + f.name;
    for (const c of ["tl", "tr", "bl", "br"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "corner-cell corner-" + c;
      b.dataset.corner = c;
      b.setAttribute("aria-label", c);
      if (f.value?.[c] !== false) b.classList.add("active");
      b.addEventListener("click", () => {
        b.classList.toggle("active");
        onChange();
      });
      grid.appendChild(b);
    }
    row.append(lab, grid);
    return row;
  }

  // Read-only info line (e.g. derived "QR + quiet zone" size).
  if (f.type === "info") {
    const row = document.createElement("div");
    row.className = "field field-info";
    row.dataset.field = f.id;
    if (f.initHidden) row.hidden = true; // shown later by updateReadouts when relevant
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
  input.addEventListener("input", () => onChange(f));
  input.addEventListener("change", () => onChange(f));

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
    if (f.type === "corners") {
      const out = {};
      for (const b of el.querySelectorAll(".corner-cell"))
        out[b.dataset.corner] = b.classList.contains("active");
      params[f.name] = out;
    } else if (f.type === "checkbox") params[f.name] = el.checked;
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
    if (f.type === "corners") {
      const v = params[f.name] || {};
      for (const b of el.querySelectorAll(".corner-cell"))
        b.classList.toggle("active", v[b.dataset.corner] !== false);
    } else if (f.type === "checkbox") el.checked = !!params[f.name];
    else el.value = params[f.name];
  }
}

// Build a { name: defaultValue } map from the field definitions, optionally
// limited to the fields under one section (group) heading.
function fieldDefaults(group) {
  const out = {};
  let cur = null;
  for (const f of FIELDS) {
    if (f.group) {
      cur = f.group;
      continue;
    }
    if (f.type === "info" || f.type === "action" || !f.name) continue;
    if (!group || cur === group) out[f.name] = f.value;
  }
  return out;
}

// Reset one section (or, with no arg, every field) to its default value.
function resetGroup(group) {
  setParams(fieldDefaults(group));
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
