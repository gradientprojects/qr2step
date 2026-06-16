# qr2step

Turn a URL (or any text) into a **two-color, 3D-printable QR code** and download it as a **STEP file** — not just STL. Everything runs in your browser; nothing is uploaded.

Most QR-to-3D tools output STL (a triangle mesh). qr2step builds true B-rep solids with [replicad](https://replicad.xyz) (OpenCASCADE compiled to WebAssembly), so the STEP file imports cleanly and stays editable in mechanical CAD.

## Features

- **STEP output** with two separate solid bodies — one per color — plus an STL export.
- **Live 3D preview** (three.js).
- **Always two-color, always scannable**: dark modules on a light background.
- **Print modes**: *Raised* (modules stand proud — single-nozzle friendly) and *Flat* (coplanar two-body, ideal for dual-nozzle / multi-material printers).
- **Outer frame** with adjustable width, outside the QR quiet zone.
- **Rounded outer corners** (modules never rounded).
- **Corner magnets**: four chamfered blind pockets, with safe-distance clamps.
- **Label panel** (one side): a blank plate, **text** in a bundled font, or an uploaded **SVG** — extruded as the dark color, outside the scan area.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build      # static site in dist/
npm run preview    # preview the production build
```

## Deploy

Pushing to the default branch builds and publishes to GitHub Pages via the workflow in `.github/workflows/deploy.yml`.

## Bundled fonts

Label-panel text uses these fonts, bundled under the SIL Open Font License (see `src/fonts/*-OFL.txt`):

- **Archivo Black** — © The Archivo Black Project Authors
- **Anton** — © The Anton Project Authors
- **Space Mono** — © The Space Mono Project Authors

## License

MIT (application code). Bundled fonts remain under their respective OFL licenses.
