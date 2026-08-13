# AGENTS.md — working in this app

Technical orientation for anyone (human or agent) making changes here. Product
framing lives in [README.md](README.md); this file is about how the code is
put together and the gotchas that aren't obvious from reading one file at a
time.

## What this is becoming

Codename **KiOnline** (final name not chosen yet — expect the string
"KiOnline" in UI text, `package.json`, storage keys, etc., but not yet in the
deployed repo/URL, which is a deliberately deferred rename). The long-term
goal is a full browser-native KiCad suite: project tree + schematic editor +
PCB editor + symbol/footprint editors, no backend, reading/writing real KiCad
files. Today it's a single-document schematic editor with project-level
open/save bolted on; the multi-pane, multi-document shell is the next major
piece of work.

## Product benchmark: parity with real KiCad

**Real KiCad is the product specification.** Work in this app should aim for
behavioral, visual, file-format, interaction, shortcut, and workflow parity
with the corresponding desktop KiCad feature. Do not substitute a generic
web-editor convention when KiCad has an established behavior; reproduce the
KiCad behavior unless a browser constraint makes that impossible. When a
constraint requires a deliberate difference, keep it narrow and document the
reason.

The single most valuable implementation reference is the local KiCad source
checkout at `C:\Projects\Personal\Electronic\kicad`. Consult it first when
implementing or correcting an editor feature, especially for interaction
state machines, defaults, serialization, geometry, and UI semantics. Treat
existing code in this app as an implementation-in-progress, not as authority
over real KiCad.

## Repo topology — read this before touching paths or `git`

- **This directory is its own git repository**, nested inside the BOMManager2
  checkout (`apps/kicad-viewer/.git` exists, separate from the root repo's).
  `git status`/`git log` run here only ever show *this* app's history — don't
  assume a `cd` to the repo root and back is a no-op for git purposes.
- It depends on `shared/kicad-io`, `shared/kicad-render`, `shared/kicad-layout`
  **two directories up**, outside its own repo, via Vite aliases (see
  `vite.config.ts`). It only works from inside a full BOMManager2 checkout (or
  a deploy pipeline that stages `./shared` locally — see `vite.config.ts`'s
  `monorepoShared`/`standaloneShared` fallback).
- `shared/kicad-io` is itself a **separate git submodule** (repo
  `KiCadParser`). Changes there need their own commit + push in that repo
  before a submodule-pointer-bump commit in BOMManager2 — otherwise this app
  builds against local-only changes that won't survive a fresh clone.
- Deploys independently to GitHub Pages (`yarn ghpages`) from whatever's
  currently checked out here — it does not go through BOMManager2's CI/deploy
  at all.

## Source layout

```
src/
  app/      bootstrap, wiring, session/state/adapters — the composition root
  editor/   interaction controllers (pointer, keyboard, tools, gestures)
  ui/       property panels/dialogs, symbol chooser — presentation-only
  io/       file/symbol-library adapters (browser FS, zip, IndexedDB cache)
```

| File | Owns |
|---|---|
| `app/MainApp.ts` | Composition root — constructs every controller/service and wires their dependencies. Start here to see how anything connects to anything else. |
| `app/wireMainAppInteractions.ts` | DOM event listener registration, kept separate from construction. |
| `app/bootstrap.ts` | One-time startup (after everything above is wired). |
| `app/SessionController.ts` | Render-session lifecycle, mode switching, project load/save/navigate — the biggest single controller. |
| `app/AppState.ts` | Cross-cutting state not yet owned by a more specific controller (see its own doc comment for the "why" of its current scope). |
| `app/Settings.ts` | `localStorage`-backed user prefs. |
| `app/StatusBar.ts` | Status/hint/coord/zoom footer + `dbg()` console logging. |
| `app/domRefs.ts` | Typed `getElementById` lookups — the one place DOM ids are strings. |
| `app/BrowserFsAdapter.ts` / `app/ZipFsAdapter.ts` / `app/ZipArchive.ts` | kicad-io's `loadFile`/`saveFile`/`PathUtils` contract implemented over File System Access API / an in-memory zip / a hand-rolled zero-dependency ZIP reader, respectively. |
| `editor/PointerController.ts` | Canvas/window pointer event flow, drag commit. |
| `editor/KeyboardController.ts` | Global shortcuts. |
| `editor/ToolStateController.ts` | Edit-tool switching + in-progress gesture reset. |
| `editor/EditGesture.ts` / `editor/PendingShape.ts` | Discriminated-union state trackers for drags and multi-click shape tools (mirrors `KicadRenderSession`'s own `EditPreviewState` pattern). |
| `editor/Toolbar.ts` | Toolbar buttons, cyclable-tool groups, persisted power-symbol choice. |
| `editor/TextInputFlow.ts` | Floating text/text-box/table input DOM flows. |
| `editor/ContextMenu.ts` / `ContextMenuController.ts` | Right-click menu surface + command dispatch. |
| `editor/ClipboardController.ts` | Copy/cut/paste/duplicate, including real-format OS clipboard round-trip. |
| `editor/PropertiesController.ts` | Sidebar + modal property panel refresh/dispatch. |
| `ui/PropertyPanel.ts` / `PropertyRenderers.ts` / `PropertyDialogRenderers.ts` / `PropertiesDialog.ts` | Per-element-kind property UI (sidebar and double-click modal share renderers). |
| `ui/SymbolChooser.ts` | KiCad-style symbol picker: virtualized list, live preview render, multi-unit placement. |
| `io/SymbolLibraryCache.ts` / `SymbolLibraryIndexer.ts` | IndexedDB-backed local symbol-library index (survives reload without re-scanning a directory). |
| `io/FileActions.ts` | Image drop/paste/placement. |

## Architecture pattern

Everything is a class that takes a `Deps` object of narrow callbacks/refs in
its constructor — no module-level mutable globals, no framework. `MainApp.ts`
is the only file that knows how all the pieces fit together; individual
controllers only know their own `Deps` interface. When adding a new
controller, follow this shape rather than reaching into another controller's
internals or back into `MainApp.ts`'s local variables.

`main.ts` itself is now just an entry point that calls into `app/`; the
history of *why* it's shaped this way (it was a single ~4800-line file) is
git history at this point, not something you need to reconstruct — just
follow the current pattern above.

## kicad-io's environment-agnostic seam

`KicadSExprFile`/`KicadSchematic`/`KicadBoard`/`KicadProject` (in
`shared/kicad-io`) never touch `fs`/`path` directly — they take an injected
`loadFile: (path) => Promise<string>`, optional
`saveFile: (path, content) => Promise<void>`, and a `PathUtils` object. That's
what makes the same model classes work identically against Node (BOMManager2's
`api`), a real directory (`BrowserFsAdapter`), or an in-memory zip
(`ZipFsAdapter`, read-only — no `saveFile`). If you need a new storage
backend, implement that contract; don't add a new code path into the model
classes themselves.

## Dev workflow

```bash
yarn dev                              # localhost:5173, HMR
yarn exec tsc -p tsconfig.json --noEmit   # type-check (also runs as part of `yarn build`)
yarn build                            # full production build
```

No test suite lives in this app (`shared/kicad-io` has its own `vitest`
suite — see that submodule). Verification here is **always** a manual browser
pass: load a real multi-sheet project, exercise the changed feature, check
the console for errors. Don't claim a UI change works without having done
this.

## Conventions

Same house rules as the rest of BOMManager2 (see the root instructions if
you're missing them): no unrequested abstractions, no comments explaining
*what* code does (only non-obvious *why*), `/** ... */` for any multi-line
comment, no backwards-compat shims for internal-only code — this app has no
external consumers of its internals to stay compatible with.
