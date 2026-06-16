# Changelog

## [0.1.0] — unreleased

Initial release.

- Browser-only pipeline: URL/text → QR matrix → two-body B-rep solids → **STEP** (+ STL) export, all client-side.
- replicad (OpenCASCADE WASM) geometry in a Web Worker; three.js live preview with an orthographic "normal" view (press **N**).
- Two-color model: light body (plate/background/quiet zone/panel) + dark body (modules/frame/label).
- Print modes: Raised and Flat (dual-nozzle / multi-material).
- Error-correction levels L/M/Q/H (default Q, robust for printed codes); live module-size readout with a too-small-to-print warning.
- Outer frame, rounded outer corners with per-corner selection, quiet-zone enforcement (min 4 modules).
- Corner magnets: chamfered blind pockets with floor and edge-clearance clamps.
- Label panel on any side: blank plate, **text** (bundled OFL fonts or your own uploaded font, processed entirely in-browser), or **SVG** upload — with horizontal/vertical alignment.
- Settings export/import, plus a one-click bug report (prefilled GitHub issue) and diagnostics log export.
- GitHub Actions deploy to GitHub Pages.

### Fonts

Bundled label fonts under the SIL Open Font License (see `src/fonts/*-OFL.txt`): Archivo Black, Anton, Space Mono. Uploaded fonts never leave your browser.
