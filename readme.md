# KFM HSE Observations Dashboard

Self-contained local web app for **KFM / Khansaheb** HSE observations at **KEZAD / Al Ma'Mourah**.

Supports observation register, KPI dashboard, Leaflet map, Before/During/After photo gate, and branded **PDF + Excel** closeout exports for Maximo attachment.

Original source Excel files under the parent folder are **not modified**. Seed data is copied into `data/seed.json` and `js/seed-embedded.js`.

## Quick start

### Option A — open the file

Open:

```
index.html
```

in Chrome, Edge, or Firefox.

### Option B — local server (recommended)

From this folder:

```bash
cd webapp
python3 -m http.server 8765
```

Visit [http://localhost:8765](http://localhost:8765).

## Features

1. **Dashboard** — total raised, editable target (default 40 cumulative), % of target with Achieved/Below colouring, status/risk/category/zone charts, closeout-ready count, open high-risk list, ageing, data-quality flags.
2. **Observations register** — add / edit / delete; seeded with 20 rows from `source-observations.xlsx` (Status defaults to Open). Category and Risk Level split from original Risk Category text. Lat/Lng parsed from location when present.
3. **Map** — Leaflet + OpenStreetMap; risk-coloured pins; Google Maps link list. Rows without GPS stay off the map.
4. **Photos & closeout gate** — per WO upload Before / During / After (stored as compressed data URLs in `localStorage`). Closeout Ready **only** when all three images exist **and** the WO is in the register.
5. **Closeout export** — PDF and Excel (`.xlsx`) with KZ / Khansaheb logos, WO details, and the three photos. Batch export for all ready WOs. Export buttons stay disabled until ready.
6. **Persistence** — `localStorage` + seed JSON. **Export JSON** backup and **Reset to seed**.
7. **Instructions** tab — field workflow for Maximo closeout attachment.

## Sample WOs with CONTROL photo paths

`2933872` and `2933877` had local OneDrive photo paths in the source CONTROL sheet. Those files are **not** bundled. Their photo slots start **empty**, so closeout readiness correctly shows **0 ready** until you upload images.

## Branding assets

Extracted from `source-closeout.xlsx` → `assets/logo-kz.png`, `assets/logo-khansaheb.jpeg`.

## Limits (v1)

- No login / multi-user sync.
- Photos live in browser storage (resized JPEGs). Very large galleries may hit quota — use **Export JSON** and clear old photos if needed.
- Map tiles require network (OpenStreetMap).
- Offline libraries are vendored under `lib/` (Leaflet, Chart.js, SheetJS, jsPDF, ExcelJS).

## Folder layout

```
webapp/
  index.html
  README.md
  css/styles.css
  js/app.js store.js export.js seed-embedded.js
  data/seed.json
  assets/          logos
  lib/             vendored JS/CSS
  uploads/         reserved for future file-based photo storage
```
