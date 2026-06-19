# Changelog

All notable changes to qr2step are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **Anonymous usage analytics** via [GoatCounter](https://www.goatcounter.com/) — a single cookieless page-view ping so we can tell whether the tool is being used. No cookies, no localStorage, no cross-site tracking, no personal data stored, and your IP is never retained (used transiently for a country lookup and an 8-hour-rotating session hash, then discarded). Nothing you type, render, or export is ever sent. A new **Privacy & analytics** section in the README documents exactly what is and isn't collected, and any tracker blocker drops the request with no effect on the tool.

## [0.1.1] — 2026-06-18

### Fixed

- Intermittent build failures on dense codes (notably higher EC levels): the QR modules **and** their diagonal connectors are now merged with a single robust polygon union instead of a chain of CAD booleans. This fixes both the boolean abort and the follow-on meshing crash on the QR body, and speeds up the build.
- A related build failure in **Flat** mode (frame + text label on dense codes): the colored parts are now cut into the plate as separate solids rather than merged into one 2D tool first, avoiding the same fragile boolean.

### Changed

- Clicking into the 3D preview now moves keyboard focus there, so the **N** (normal view) shortcut works immediately without first clicking out of a field.
- The diagonal-bridge readout is clearer: it only appears when the connector width was actually capped, and tells you the QR-area size needed to reach your requested width.

## [0.1.0] — 2026-06-17

Initial public release.

### Added

- Browser-only pipeline: URL/text → QR matrix → two-body B-rep solids → **STEP** (+ STL) export, all client-side.
- replicad (OpenCASCADE WASM) geometry in a Web Worker; three.js live preview with an orthographic "normal" view (press **N**).
- Two-color model: light body (plate/background/quiet zone/panel) + dark body (modules/frame/label).
- Print modes: Raised and Flat (dual-nozzle / multi-material).
  - Flat STEP exports as separate **named, colored bodies** — `Tile`, `QR Code`, `Frame`, `Label` — so slicers show meaningful, separately-assignable parts instead of dozens of anonymous solids. (Slicers don't auto-map STEP colors to filaments, so you assign each named group once.)
  - Raised STEP fuses into a single solid (two colors via a slicer color-change at module height).
- Smart export filenames derived from the QR content plus build variant — `name-WxHmm-ec<level>-<mode>[-mag].step` — with an optional **File name** override and a live "Saves as:" preview. Settings export is named to match.
- Error-correction levels L/M/Q/H (default Q, robust for printed codes); live module-size readout with a too-small-to-print warning.
- Outer frame, rounded outer corners with per-corner selection, quiet-zone enforcement (min 4 modules).
- Corner magnets: chamfered blind pockets with floor and edge-clearance clamps. Position by **inset from corner** (symmetric) or **XY pattern** (independent centre-to-centre Spacing X / Spacing Y, to match a mounting jig/base).
- Label panel on any side: blank plate, **text** (bundled OFL fonts or your own font file, read entirely in-browser), or **SVG** — with horizontal/vertical alignment.
- Settings export/import, plus a one-click bug report (prefilled GitHub issue) and diagnostics log export.
- GitHub Actions deploy to GitHub Pages.

#### Navigation & editing

- Camera: **orbit around the point under the cursor** (left/middle-drag), **pan with Ctrl+drag or right-drag** (snappy/undamped), scroll **zooms toward the pointer**. Touch: one-finger rotate, two-finger pan/zoom.
- **Undo / redo** (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z) across parameter changes.
- **Reset to defaults** — per-section (↺ on each heading) and a global **Reset all** in the header.
- Edits debounce before the (expensive) rebuild, and rebuilds that wouldn't change anything are skipped.

#### Fonts

Bundled label fonts under the SIL Open Font License (see `src/fonts/*-OFL.txt`): Archivo Black, Anton, Space Mono. Uploaded fonts never leave your browser.
