# KiCad Viewer (SPA)

No-backend browser app for:

1. **Open file** — view local `.kicad_sch` / `.kicad_pcb`
2. **Circuit layout** — place from recipe + IC symbol, drag/rotate parts, auto-remake Manhattan wires

Shares the same libraries as BOMManager2 (no duplicated router/painter):

- `@kicad-io` → `../../shared/kicad-io`
- `@kicad-render` → `../../shared/kicad-render`
- `@kicad-layout` → `../../shared/kicad-layout`

## Run

```bash
cd apps/kicad-viewer
yarn install
yarn dev
```

Open http://localhost:5173 — **Circuit layout → Load demo → Place → drag a part**.

## Deploy to GitHub Pages

This app builds against `../../shared` (must stay inside the BOMManager2 checkout). Publish the built SPA to [`kaminaris/KiCadViewer`](https://github.com/kaminaris/KiCadViewer):

```bash
cd apps/kicad-viewer
yarn deploy
```

That builds `dist/` and pushes it to the `gh-pages` branch.

Then once in the GitHub UI:

1. Open **Settings → Pages**
2. **Source**: Deploy from a branch
3. **Branch**: `gh-pages` / `/ (root)`
4. Save

Site URL: **https://kaminaris.github.io/KiCadViewer/**

(`vite.config.ts` sets `base: '/KiCadViewer/'` for that project Pages path.)

## Notes

- LM recipe generation, BOM DB, and sessions stay in BOMManager2.
- Create `git@github.com:kaminaris/KiCadLayout.git` and push `shared/kicad-layout` when ready to publish that submodule.
