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
npm install
npm run dev
```

Open http://localhost:5173 — **Circuit layout → Load demo → Place → drag a part**.

## Notes

- LM recipe generation, BOM DB, and sessions stay in BOMManager2.
- Create `git@github.com:kaminaris/KiCadLayout.git` and push `shared/kicad-layout` when ready to publish that submodule.
