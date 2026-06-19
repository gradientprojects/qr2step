# qr2step

**▶ Live app: https://gradientprojects.github.io/qr2step/**

Turn a URL (or any text) into a **two-color, 3D-printable QR code** and download it as a **STEP file** — not just STL. It runs entirely in your browser: your text, and any font or SVG you pick, are read and processed locally and never uploaded to a server (there isn't one).

Most QR-to-3D tools output STL (a triangle mesh). qr2step builds true B-rep solids with [replicad](https://replicad.xyz) (OpenCASCADE compiled to WebAssembly), so the STEP file imports cleanly and stays editable in mechanical CAD.

## Privacy & analytics

Your QR content never leaves your browser — see above. The only thing this site sends anywhere is a single anonymous page-view ping, via [GoatCounter](https://www.goatcounter.com/), so we can tell whether the tool is being used at all.

What that means for you:

- **No cookies, no localStorage, no tracking** — nothing is stored on your device, and nothing follows you across visits or other sites. No consent banner because there's nothing to consent to.
- **No personal data is stored.** GoatCounter records only aggregate, anonymized page views: the path visited, referrer, browser, screen size, a coarse country, and a timestamp.
- **Your IP address is never stored.** It's used transiently to derive the country and a session hash that rotates every few hours, then discarded — it can't be tied back to you.
- **Nothing you type, render, or export is ever sent** — not the URL/text, not your font or SVG, not the QR itself.

If you'd rather send nothing at all, any content/tracker blocker will drop the GoatCounter request with zero effect on the tool.

## Features

- **STEP output** with two separate solid bodies — one per color — plus an STL export.
- **Live 3D preview** (three.js).
- **Always two-color, always scannable**: dark modules on a light background.
- **Print modes**: *Raised* (modules stand proud — single-nozzle friendly) and *Flat* (coplanar two-body, ideal for dual-nozzle / multi-material printers).
- **Outer frame** with adjustable width, outside the QR quiet zone.
- **Rounded outer corners** (modules never rounded).
- **Diagonal bridges** (on by default): diagonally-touching modules meet at a single non-manifold point, which CAD/slicers split into separate "confetti" parts. A thin sliver of material is added at each pinch so the dark body is manifold/watertight — it imports as connected geometry and prints as one piece. Width is adjustable and auto-capped so it never hurts scanning.
- **Corner magnets**: four chamfered blind pockets, with safe-distance clamps.
- **Label panel** (one side): a blank plate, **text** in a bundled font, or your own **SVG** — extruded as the dark color, outside the scan area.

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

## Credits

The UI and feature set is heavily inspired by the great tool at [qrcode2stl](https://qrcode2stl.printer.tools/), but it's built from scratch.

## License

MIT (application code). Bundled fonts remain under their respective OFL licenses.
