# KiOnline *(codename — not final)*

A no-backend, browser-native KiCad-compatible EDA tool. Everything — parsing,
rendering, editing, project I/O — runs client-side; there is no server, no
account, no upload. It reads and writes real `.kicad_sch` / `.kicad_pcb` /
`.kicad_pro` files byte-for-byte compatible with desktop KiCad.

This app started as a schematic viewer + auto-layout demo and is being grown
into a full KiCad-in-the-browser suite (see [AGENTS.md](AGENTS.md) for where
things stand architecturally and what's still ahead).

## What it does today

- **View** — open a single `.kicad_sch` / `.kicad_pcb` read-only.
- **Circuit layout** — place a part from a recipe + IC symbol, drag/rotate,
  auto-remake Manhattan wires. The original proof-of-concept demo mode.
- **Edit** — a real schematic editor: draw wires/buses/labels/power symbols,
  place library symbols, multi-select/align/group, copy-paste (including to
  the OS clipboard in real KiCad format), undo/redo, per-kind property
  dialogs, context menus — most of a day-to-day KiCad schematic workflow.
- **Whole-project support** — open a project as:
  - a local folder via the File System Access API (Chrome/Edge), with save
    back to disk and hierarchical sheet navigation, or
  - a `.zip` (read-only), unpacked entirely client-side — no library, just a
    hand-rolled ZIP reader over the native `DecompressionStream` API.
  - **New Project** scaffolds a blank `.kicad_sch` / `.kicad_pcb` /
    `.kicad_pro` set that opens cleanly in real KiCad.

Firefox/Safari lack the File System Access API, so folder open/save and New
Project are Chromium-only for now; single-file open and zip import work
everywhere.

## Run

```bash
cd apps/kicad-viewer
yarn install
yarn dev
```

Open http://localhost:5173 — **Circuit layout → Load demo → Place → drag a
part**, or just drop a `.kicad_sch`/`.kicad_pcb` in View mode.

## Shared libraries

Built against the same libraries as the rest of BOMManager2 — no duplicated
parser/router/painter:

- `@kicad-io` → `../../shared/kicad-io` (parse/write, git submodule)
- `@kicad-render` → `../../shared/kicad-render` (paint/session/hit-test)
- `@kicad-layout` → `../../shared/kicad-layout` (auto-place/route)

## Deploy to GitHub Pages

This app builds against `../../shared` (must stay inside the BOMManager2
checkout). It currently still publishes to the pre-rebrand
[`kaminaris/KiCadViewer`](https://github.com/kaminaris/KiCadViewer) repo —
that repo/URL rename is deliberately deferred until a final (non-codename)
name is picked, so it isn't touched here:

```bash
cd apps/kicad-viewer
yarn ghpages
```

That builds `dist/` and pushes it to the `gh-pages` branch. Site URL:
**https://kaminaris.github.io/KiCadViewer/** (`vite.config.ts` sets
`base: '/KiCadViewer/'` for that project Pages path).

## Notes

- LM recipe generation, BOM DB, and sessions stay in BOMManager2's `web`/`api`
  — this app has no backend and never calls into them.
- `shared/kicad-layout` isn't published as its own repo yet; do that
  (`git@github.com:kaminaris/KiCadLayout.git`) before relying on it outside
  this monorepo checkout.
