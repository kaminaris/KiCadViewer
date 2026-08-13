# PCB (board) editing for kicad-viewer

## Progress

Last updated: 2026-08-13

- [x] PCB editor shell and KiCad-style Appearance/layer panel.
- [x] Phase 0 implementation: retained mutable board AST, board serialization, board edit mode, footprint dragging, board-aware undo/redo, and board text cache synchronization.
- [x] Phase 1 implementation: whole-footprint hit target and visible selection outline, rectangle selection/group drag, track/via click selection, rotate/flip/delete shortcuts, and a PCB-specific context menu.
- [ ] Phase 0/1 real-KiCad round-trip verification. Production build passes; browser import/export and opening the result in desktop KiCad remain to be checked.
- [x] Phase 2 implementation — net-aware track/via AST elements, Select/Route/Via toolbar, 45° interactive routing preview, net inheritance, via insertion, and keyboard layer switching.
- [x] Phase 3 implementation — layer-aware copper connectivity, MST ratsnest, live recomputation after mutations, and Appearance → Objects visibility toggle.
- [x] Phase 4 implementation — PCB sidebar/modal properties for footprints, tracks, vias, and pads; double-click opens the modal.
- [x] Phase 5 implementation — continuous board text persistence, in-memory PCB preservation across view switches, Save Project board re-sync, and `.kicad_pcb` export.
- [x] PCB navigation follow-up — wheel zoom plus middle- and right-button drag panning remain available with every board tool, including Route and Via.
- [x] PCB selection follow-up — footprint picking now mirrors KiCad's convex physical hull and excludes distant reference/value fields instead of using one oversized rectangular render bbox.
- [x] PCB grid follow-up — PCB spacing and snapping are persisted independently from the schematic, with board-specific metric presets and a dedicated PCB Preferences page.
- [x] KiCad mouse setting follow-up — added the app-wide "Center and warp cursor on zoom" preference with KiCad-equivalent centered versus cursor-anchored camera zoom; browser pointer-warp restrictions are stated in the UI.
- [x] PCB polygon rendering follow-up — registered and rendered KiCad `fp_poly` geometry with footprint transforms, KiCad fill/stroke fields, and concave-safe polygon filling for artwork such as the Open Hardware logo.
- [x] Interactive Move follow-up — `M` is a configurable Common shortcut for a persistent, grid-snapped move in both editors; mouse motion uses the same immediate update path as the existing schematic drag interaction, arrow keys nudge from the unchanged physical-cursor anchor, click/Enter commits, Escape cancels without leaving a redo entry, and middle/right-button pan remains available.
- [ ] Phase 2–5 real-board verification. The in-app browser opens the app cleanly, but its file chooser currently times out before handing the prepared CM5 zip to the page; desktop KiCad round-trip still needs a manual pass.

Implementation note: board scene rebuilds now preserve Appearance layer visibility/opacity choices, so dragging or transforming a footprint does not reset the panel.

Validation checkpoint: `yarn build` passes. Focused shared tests pass (9/9: WithNet serialization and layer-aware ratsnest). The full shared parser suite currently reports 134 passing, 14 failing fixture-normalization tests, and 2 skipped; those broader fixture expectations remain a separate existing cleanup item.

## Context

At plan creation, the app's schematic side had a mature edit mode (hand-drawn wires/labels/power symbols, real-library symbols, multi-select/group-drag, align, copy/paste, group/ungroup, undo/redo, per-kind property dialogs), while PCB support was view-only: real WebGL rendering and a working layer/appearance panel, but no editing. The implementation below closes that gap while reusing schematic architecture where it fits and diverging where PCB concepts genuinely differ (routing, nets, layers).

Research (3 parallel Explore agents + direct verification) found the foundational blocker: `KicadRenderSession.loadBoardText()` parses the board but never retains the AST (`const boardRoot = { rootElement }` is a **local** variable, never assigned to `this` — contrast schematic's `this.schematicRoot = schematicRoot`). Nothing above kicad-io can mutate+save a board today, even trivially. Everything else builds on fixing that.

The existing `#board-tool-panel` in `index.html` already has 7 disabled buttons with pre-written titles that encode an intended rollout order: Select → Route Single Track → Route Diff Pair → Place Via → Tune Track Length → Add Filled Zone → Add Rule Area. This plan follows that ordering for the in-scope portion (through Place Via) and explicitly defers the rest.

## Architecture decisions

**1. New parallel `BoardPointerController`, not a generalized `PointerController`.** `PointerControllerDeps` (`apps/kicad-viewer/src/editor/PointerController.ts:14-90`) is ~40 members deep in schematic vocabulary (`getRuleAreaPoints`, `getCurrentPowerKind`, `getLineChainStart`, etc.). `BoardAppearancePanel` already establishes the precedent of a small, self-contained class that self-gates on `documentTypeLoaded !== 'board'` rather than generalizing the schematic equivalent. Build `BoardPointerController` the same way — constructed unconditionally alongside `PointerController`, each no-ops when the loaded document doesn't match its domain. Share only logic-free primitives (`screenPosFromEvent`, drag-threshold), not a base class — the two state machines diverge immediately.

**2. `KicadRenderSession` mutation methods: generalize the thin ones, keep the ones with real schematic logic separate, branch undo/redo.**
- `translateElementGeometry` (`:3177-3211`) is already 100% generic (duck-typed dispatch over `getOrigin/setOrigin`, `getStartEnd/setStartEnd`, etc.) — zero changes needed, just stop walling it off.
- `deleteElements`, `mutateElementByPaintId`, `mutateElementsByPaintIds`, `translateElementById` are thin wrappers (id→element lookup, mutate, commit) — generalize these by replacing the `documentType !== 'schematic'` guard + hardcoded `this.schematicRoot`/`this.schScene` reads with a new `get activeRoot()` accessor (mirrors the existing `get activeScene()` at `:307-309`).
- `translateSelection` carries real schematic-only logic (symbol-owner tracking, sheet/sheet-pin absolute moves) with no board equivalent — board gets its own simpler `translateBoardSelection(ids, dx, dy)`: loop `translateElementById` under one batch, no owner-exception branch.
- Undo/redo (`:1409-1485`) branches on `documentType` to call `getSchematicText()`/`loadSchematicText()` vs. the new `getBoardText()`/reload-in-place — the stack itself (`undoStack: string[]`) stays shared/untouched.
- `hitTestRect`/`expandGroupSelection` are **not** generalized — boards have no group/nesting concept, so board gets its own simpler `hitTestBoardRect()`.

**Two verified correctness hazards to respect throughout:**
- `WithOrigin.setOrigin(x, y, rotation?)` does `existing.rotation = rotation ?? 0` — omitting rotation silently zeroes it. Every footprint/via move or rotate call **must** pass through the current rotation explicitly.
- A pad's own `(at x y)` is footprint-**local** (only converted to world space at paint time via `footprintMatrix`), even though pads are directly hit-testable (`BoardPainter.ts` pad items have `hitTestable: true`). Any mutation reached via a pad hit must first walk `.parent` (set by the parser on every child, `KicadElement.ts:20,24`) up to the owning `KicadElementFootprint` and mutate that, never the pad directly with a world-space delta — otherwise a drag silently corrupts the pad's local offset.

Also: today only pads are hit-testable on a footprint (text labels and all footprint graphics are `hitTestable: false`) — clicking silkscreen outline currently hits nothing. Phase 1 adds one synthetic whole-footprint `PaintedItem` (union bbox, pushed first so pads/text keep hit-priority on overlap) to fix this.

## Phase 0 — Foundation: AST retention + save round-trip (footprint move only)

Narrowest possible vertical slice proving the whole pipeline before touching routing.

- `shared/kicad-render/KicadRenderSession.ts`: add `boardRoot` field (set it in `loadBoardText()` — currently discarded), `get activeRoot()`, `getBoardText()` (mirrors `getSchematicText()`), generalize `commitAstMutation` to rebuild whichever scene is active, add `moveFootprintByPaintId(paintId, x, y)` (resolve pad→footprint owner per the hazard above, call `setOrigin(x, y, existingRotation)`), branch `pushUndoSnapshot`/`undo`/`redo` on `documentType`.
- `apps/kicad-viewer/src/app/AppState.ts`: add `boardText`/`refreshBoardText(session)`/`setBoardText()` mirroring the schematic equivalents — doing this now means every later phase's mutations flow through it from day one instead of retrofitting in Phase 5.
- `apps/kicad-viewer/src/app/SessionController.ts`: remove the unconditional `if (this.state.kind === 'board') { next = 'view'; }` in `setMode()` (keep circuit-mode excluded for boards, since auto-rewire is schematic-only); `refreshModeAvailability()` stops disabling the Edit button for boards; `loadText()` sets `'edit'` for both kinds.
- `apps/kicad-viewer/src/editor/BoardPointerController.ts` (new): mousedown/move/up wiring; hit pad/footprint-ref → select + drag via `moveFootprintByPaintId` + `appState.refreshBoardText(session)`. No rotate/flip/delete/rect-select yet.
- `apps/kicad-viewer/src/app/wireMainAppInteractions.ts`: construct `BoardPointerController` alongside `PointerController`.

**Verify:** import a real board zip, drag a footprint to a new grid-snapped position, Ctrl+Z reverts it. Export — the `.kicad_pcb` text has the new `(at ...)` and opens cleanly in real KiCad with the part in the new spot and its rotation unchanged.

## Phase 1 — Basic editing: move/rotate/flip/delete, real selection

- `shared/kicad-render/paint/BoardPainter.ts`: add `kind: 'footprint'` — one synthetic hit-testable item per footprint (union bbox of its pads/text/graphics), pushed first in that footprint's item group.
- `shared/kicad-render/KicadRenderSession.ts`: `rotateFootprintByPaintId(paintId, degrees)`, `flipFootprintByPaintId(paintId)` (swap F.Cu/B.Cu, negate rotation — **defer** per-pad-layer remapping for asymmetric padstacks as a known simplification, flag in a code comment); generalize `deleteElements`/`mutateElementByPaintId`/`mutateElementsByPaintIds` per decision 2; add `hitTestBoardRect()` and `translateBoardSelection()` (both deliberately simpler than schematic's, per decision 2 — pad hits resolve to their footprint owner).
- `apps/kicad-viewer/src/editor/BoardPointerController.ts`: rect-select drag, rotate (`R`)/flip(`F`)/delete keys, context-menu entries (reuse `ContextMenuController`'s existing DOM-builder pattern).
- `apps/kicad-viewer/src/editor/KeyboardController.ts`: board-aware branch for `R`/`F`/`Delete` when in board edit mode.

**Verify:** rectangle-select multiple footprints by dragging over empty space. Click anywhere on a footprint's silkscreen (not just a pad) — it selects. `R` rotates live, right-click Flip moves it to the back layer and mirrors silkscreen. Delete an existing track/via from the imported board. Undo restores each step. Export round-trips through real KiCad.

## Phase 2 — Interactive track routing + via placement

Kept as one phase — via placement is naturally bundled with routing in real KiCad too.

- `shared/kicad-io/src/Mixins/WithNet.ts` (new): `getNetId()`, `getNetName()`, `setNet(id, name?)` — find-or-create a `KicadElementNet` child. Mix into `KicadElementSegment`, `KicadElementVia`, and `KicadElementPad` (none currently have a net accessor).
- `apps/kicad-viewer/src/editor/PendingShape.ts`: extend the union with `{ kind: 'route'; netId: number|null; layer: string; corners: Vec2[] }` — `PendingShapeTracker` itself needs no changes, it's already a pure logic-free holder. `BoardPointerController` owns its own instance.
- `shared/kicad-render/KicadRenderSession.ts`: `addTrackSegment(x1,y1,x2,y2,width,layer,netId?)` and `addVia(x,y,size,drill,layers,netId?)` (mirror `addWire`'s shape: undo snapshot, construct element, set fields, attach, commit); `netIdAtScreen(screenPos)` (hit-test, read net off pad/track/via via the new mixin).
- Note: copper tracks need **no explicit junction element** for a T-branch — two same-net segments touching at a point are simply connected in KiCad's own model (no junction dot on copper). Starting a new route mid-existing-track is just "read net at that point, start a fresh segment" — no AST change to the segment being branched from.
- `apps/kicad-viewer/src/editor/BoardPointerController.ts`: click-to-route state machine (start on pad/via/track/empty → click for 45°-mitered corners → double-click/Enter to finish → Escape to cancel); `place-via` tool.
- `apps/kicad-viewer/src/app/ActiveDocument.ts`: reuse the existing `activeBoardLayer` field (already present, and `BoardAppearancePanel`'s own doc comment already anticipates this: "the selected active layer becomes routing state once the interactive router is introduced").
- `apps/kicad-viewer/src/editor/KeyboardController.ts`: PageUp/PageDown (F.Cu/B.Cu), `+`/`-` (cycle copper stack), `V` (swap layer pair) — mutate `activeBoardLayer`.
- `apps/kicad-viewer/index.html`: add `data-tool` to Select/Route Single Track/Place Via buttons, remove `disabled` from those two, new small `BoardToolbar` class (mirrors `Toolbar.ts` but scoped to `#board-tool-panel [data-tool]`, since `Toolbar` hardcodes `#tool-panel`).

**Verify:** route a track from a pad through a couple of mitered corners to another pad — inherits net, correct layer. Start a new route by clicking mid-an-existing-track — inherits that net, no junction artifact. Switch layer via PageDown mid-session. Place a via on a track — inherits net, connects both layers. Export and reopen in real KiCad — valid, correctly-netted tracks/vias.

## Phase 3 — Net model + ratsnest

- `shared/kicad-render/paint/BoardPainter.ts`: add `netId`/`netName` to `PaintedItem`, populate via the Phase 2 mixin.
- New ratsnest module (e.g. `shared/kicad-render/paint/BoardRatsnest.ts`): per-net union-find over pad anchors joined by existing track/via chains, then MST over the unrouted remainder. Skip Delaunay triangulation (real KiCad needs it for performance at board scale we won't hit) — plain O(n²) per-net MST is fine given typical net sizes.
- `shared/kicad-render/KicadRenderSession.ts`: `getRatsnestLines()`, recomputed on board mutation.
- `apps/kicad-viewer/src/ui/BoardAppearancePanel.ts`: ratsnest visibility toggle in the Objects tab.

**Verify:** unrouted nets show thin dashed airwires between same-net pads; routing a track makes the corresponding airwire disappear immediately; toggle works.

## Phase 4 — Property panels for board items

- `apps/kicad-viewer/src/editor/BoardPropertiesController.ts` (new): reuses the existing `PropertyPanel`/`PropertiesDialog` DOM primitives unchanged (confirmed generic — label/value/save-callback only, no schematic-kind assumptions).
- Per-kind fields: Footprint (Reference/Value editable, rotation numeric, layer read-only), Track (width/layer editable, net read-only), Via (size/drill/layers editable, net read-only), Pad (read-only info only — no position field, since pad repositioning belongs to a footprint editor, out of scope).
- Wire double-click → modal and single-select → sidebar in `BoardPointerController`, mirroring the schematic pattern.

**Verify:** double-click a footprint, edit Value, confirm it updates on the board and in exported text. Double-click a track, change width/layer live.

## Phase 5 — Save/persistence wiring

`ProjectStore.saveSheet`/`connect` are already generic by path and `DocumentKind` — this phase is mostly wiring, not inventing, because Phase 0 already threads `refreshBoardText` through every mutation.

- `apps/kicad-viewer/src/app/SessionController.ts`: branch the `setTextCommitHandler` callback on `state.kind` (board keys off `mainBoard?.path`); `saveProject()` currently only re-syncs the schematic before `saveAll()` — add the mirrored board sync (`session.getBoardText()` → `project.mainBoard.data`/`rootElement`). `saveAll()` already unconditionally calls `mainBoard.save()`, so this fix is what actually gets board edits to disk/zip.
- Confirm/add a board equivalent of whatever drives schematic export/download.

**Verify:** edit a board, switch to schematic tab and back — edits persisted via continuous save. Hit Save Project, reload the whole project from scratch — edits still there. Reopen the saved file in real KiCad.

## Explicitly out of scope (future work, not this pass)

- Differential pair routing, track length tuning (buttons stay disabled)
- Filled zones and rule areas/keepouts — `KicadElementZone` has **zero** mutation methods today (read-only accessors only); this is substantial standalone follow-on work
- Any DRC (clearance, track-width-vs-netclass, annular ring)
- Per-layer pad remapping on flip (asymmetric custom padstacks) — flagged simplification from Phase 1
- Net reassignment UI for existing tracks/vias
- A dedicated footprint/pad editor

## Critical files

- `shared/kicad-render/KicadRenderSession.ts` — the foundational AST-retention gap and every mutation primitive
- `shared/kicad-render/paint/BoardPainter.ts` — whole-footprint hit item (Phase 1), net-id plumbing (Phase 3)
- `shared/kicad-io/src/Mixins/WithNet.ts` — new, required for routing and ratsnest
- `apps/kicad-viewer/src/editor/BoardPointerController.ts` — new, the entire board gesture surface
- `apps/kicad-viewer/src/app/SessionController.ts` — the mode-lock removal (Phase 0) and save wiring (Phase 5)

## Verification

No automated test suite covers render/app layers (only `shared/kicad-io` has vitest — add round-trip tests there for `WithNet` and any new element mutation if convenient, matching the existing `editModeElements.test.ts` pattern). Primary verification is `tsc --noEmit` + `yarn build` after each phase, then a real browser pass per phase's "Verify" note above, using a real imported KiCad board zip (the `build-zip.js` scratchpad script from this session works for this) — always cross-check the final exported `.kicad_pcb` opens cleanly in real KiCad, not just that it round-trips through this app's own parser.
