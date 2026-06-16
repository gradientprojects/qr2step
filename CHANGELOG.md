# Changelog

## [0.1.0] — unreleased

Initial scaffold.

- Browser-only pipeline: URL/text → QR matrix → two-body B-rep solids → **STEP** (+ STL) export, all client-side.
- replicad (OpenCASCADE WASM) geometry in a Web Worker; three.js live preview.
- Two-color model: light body (plate/background/quiet zone/panel) + dark body (modules/frame).
- Print modes: Raised and Flat (dual-nozzle / multi-material).
- Outer frame, rounded outer corners, quiet-zone enforcement (min 4 modules).
- Corner magnets: chamfered blind pockets with floor and edge-clearance clamps.
- Label panel: blank-plate extension on any side (text & SVG to follow).
- GitHub Actions deploy to GitHub Pages.
