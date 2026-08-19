# UI Component Catalog

Reusable UI building blocks in `src/ui/`, shared across the schematic editor,
PCB editor, symbol editor, and (future) footprint editor. Plain TypeScript
classes with a consistent mount/render contract — no framework. Prefer
extending/reusing one of these over writing new bespoke DOM/CSS for
something that already exists here.

Design system: new components build their own DOM via [`el()`](#domts) and
reuse the app's existing CSS class vocabulary (`.tool-btn`/`.tool-panel`,
`.top`/`.brand`/`.breadcrumb`, `.stage`, `.status-bar`, `.edit-left-pane`/
`.edit-pane`) for visual parity, or the newer `.kd-*` prefix for genuinely
new widgets (e.g. `.kd-select-*`). Components own their own HTML — they do
not clone fragments out of `index.html`.

## Foundations

### `Dom.ts`
Typed DOM-builder primitives everything else here is written with.
- `el(tag, props?, children?)` — `createElement` + `Object.assign`, with
  special-cased `class`/`style`/`dataset` props. No `innerHTML`, no XSS
  surface, no templating engine.
- `append(parent, children)` — appends a child or array of children,
  silently skipping `null`/`undefined`/`false` (lets callers write
  conditional children inline with `cond && el(...)`).
- `svgIcon(paths, viewBox?)` — builds an `aria-hidden` inline `<svg>` from
  one or more path `d` strings.
- `buildFilterSearch(placeholder)` — the ⌕-icon + `<input type="search">`
  box every library list uses (`SymbolChooser`/`FootprintChooser` modals,
  the Symbol Editor's Libraries pane). Previously hand-copied three ways
  (static HTML in `index.html` twice, a separate JS build in
  `SymbolEditorScreen.ts`); `LibraryChooser`'s constructor now builds it
  itself and inserts it after `.symbol-chooser-header`, so `index.html` no
  longer hand-codes the modal search boxes at all.

### `search/TextScore.ts`
Shared fuzzy-search scorer, ported from eeschema's
`LIB_TREE_NODE::UpdateScore`/`EDA_COMBINED_MATCHER::ScoreTerms` (AND across
search terms, OR across weighted fields, exact/prefix/substring tiers).
Originally duplicated byte-for-byte between `SymbolChooser` and
`FootprintChooser`; now the one place that logic lives.
- `normalizeText(value)` — lowercase + non-alphanumeric collapsed to spaces.
- `naturalCompare(a, b)` — numeric-aware string compare (`R2` before `R10`).
- `scoreSearchQuery(query, fields: ScoreField[])` — score one item against
  a query given its weighted fields (`{ text, weight, isName }`).
- `scoreAndSort(query, rows, toFields, sortKey)` — filter + sort a list:
  exact-tier first, then score, then `naturalCompare(sortKey)` as a
  stable fallback when there's no query.

Any component with a search box over a list of named/labeled things should
build a small `scoreFields(item): ScoreField[]` and delegate to this rather
than writing its own scorer (see `SymbolChooser`, `FootprintChooser`,
`SearchableSelect` for the pattern).

## Widgets

### `ToolPalette.ts`
Sidebar/rail tool-button widget shared by every editor's tool dock.
Deliberately owns only the WIDGET (button DOM, active/disabled visual
state, click wiring) — NOT which-tool-is-active/hotkey-cycling state, which
stays in each editor's own controller (`BoardToolbar`-style state machines
are independent per editor on purpose; only the look is shared).
- `ToolButton` — one `<button class="tool-btn">` with an `svgIcon`, title
  `"Label (Hotkey)"`, `data-tool`, `aria-pressed`. `setActive()`/
  `setDisabled()`.
- `ToolPalette` — a `<aside class="tool-panel">` (or `tool-panel-horizontal`)
  of `ToolButton`s built from a `ToolButtonConfig[]`. `setActiveTool()`
  (mutually exclusive), `setToolDisabled()`, `.activeTool` getter.

### `SearchableSelect.ts`
Generalized "select with search" — trigger button + popup with a search
box and a scored/sorted option list, keyboard-navigable (Escape/Arrow/
Enter). Generalizes the trigger+popup combo `ProjectSetupController`'s
`stackupColorCell()` already had one-off, and shares `TextScore` with the
choosers. Not virtualized — for option lists in the thousands, use
`LibraryChooser`-family components instead.
- `SearchableSelectOption { value, label, description? }`
- `SearchableSelect(config, onChange)` — `.value`, `.isOpen`, `open()`/
  `close()`, `setOptions()`/`setValue()`.

## Editor frame (standalone editors: symbol editor today, footprint editor next)

These compose into the chrome any non-schematic/non-PCB editor screen
needs — header with brand/breadcrumb/save/revert, a left dock of
collapsible panes, a canvas stage, an optional tool rail, and a status bar.
The schematic/PCB screens keep their own richer, still-static `index.html`
chrome (menu bar, aux toolbars) and don't use this family directly, but
`EditorChrome` binds against either shape (see below).

### `EditorShell.ts`
Top-level shell a standalone editor screen instantiates once. Builds its
own header/main/footer from `el()` (see the file's doc comment for why —
short version: cloning `#screen-editor` and disabling everything unused
dragged in the whole schematic/PCB chrome and made the shell's actual shape
unreadable at the call site). Composes `PaneStack` (left dock),
`EditorCanvas` (stage), an optional `ToolPalette` (right tool rail),
`EditorStatusBar` (footer), and `EditorChrome` (header bindings).
- `new EditorShell({ kind, panes, tools?, actions })`
- `.root`, `.stage`, `.chrome`, `.status`, `.panes`, `.tools`
- `mount(parent)`, `mountPane(pane)`, `bindActions(actions)`

### `EditorChrome.ts`
Breadcrumb + primary-action (Save/Revert/Back) surface. Dual consumer: binds
onto EITHER the real schematic/PCB header in `index.html` (query-only —
`MainApp.ts` never calls `.bind()`, Save/Export already have menu-command
wiring there) OR a small header `EditorShell` builds itself (which DOES
call `.bind()` for real click handlers). Selectors key off `data-chrome`
attributes (`data-chrome="save"`/`"revert"`), not title-text, so both
consumers work against one class unchanged.
- `new EditorChrome(root)`, `.bind(actions)`, `.setBreadcrumb()`/
  `.setSheet()`/`.setModified()`/`.setActionsEnabled()`

### `PaneStack.ts` / `EditorPane.ts`
Left-dock of collapsible named panes (Libraries / Symbols / Properties,
etc). `PaneStack` owns the list; `EditorPane` owns one pane's header
(title + working Close button) and body swap.
- `new PaneStack(entries: PaneStackEntry[])` — `.element`, `mount(id, title,
  content)`, `setVisible(id, visible)`, `.count`
- `new EditorPane(id, title, content)` — `.element`, `mount(title,
  content)`, `setVisible(visible)`

Note: the resizable `.pane-splitter` drag handles are a separate feature
wired only against the static schematic/PCB `index.html` markup
(`wireMainAppInteractions.ts`) — this family doesn't attempt to replicate
that, by design.

### `EditorCanvas.ts`
Thin owner of an editor's stage element and its `ResizeObserver`, so resize
plumbing stays local to the screen that mounted it. `mount(...children)`,
`destroy()`.

### `EditorStatusBar.ts`
Small stateful wrapper around a status-message element. `set(message,
kind?)` where `kind` is `'normal' | 'dirty' | 'error'`.

## Modals & dialogs

### `DraggableResizable.ts`
`makeDraggableResizable(modal, dragHandle, options?)` — makes any fixed/
absolute-positioned modal draggable (by a header handle) and resizable (by
a corner handle). Used by the app's larger native-feeling dialogs (Bulk
Edit Symbol Fields, Symbol/Footprint Chooser, the Properties modal).

### `PropertiesDialog.ts`
Owns the shared double-click "Properties" modal surface (open/close
lifecycle, title, draggable/resizable via `DraggableResizable`) plus DOM
primitives dialog renderers build with: `section()`, `columns()`, and a
`KdGridColumn`/`KdGridHandlers`-driven data-grid builder (used by the
Symbol dialog's Fields grid). Per-kind content lives in
`PropertyDialogRenderers.ts`.

### `PropertyPanel.ts`
Shared DOM primitives for the edit-mode property SIDEBAR (as opposed to the
modal above) — `section()`/`row()` builders for the always-visible property
panel. Element-specific renderers live in `PropertyRenderers.ts`.

### Per-kind property dialogs
`BarcodePropertiesDialog.ts`, `BoardTextPropertiesDialog.ts`,
`RuleAreaPropertiesDialog.ts`, `PolygonPropertiesDialog.ts`,
`ZonePropertiesDialog.ts`, `LayerPairDialog.ts`, `RouterSettingsDialog.ts`,
`PreferencesDialog.ts`, `NewProjectDialog.ts` — one dialog class per element
kind, all built on the `PropertiesDialog`/`DraggableResizable`/`el()`
primitives above. Look at one of these before adding a new element-kind
dialog rather than inventing a new modal pattern.

## Library choosers

### `LibraryTreeList.ts`
Generic (`LibraryTreeList<TItem>`) virtualized, collapsible TREE widget —
one row per library group with an expand/collapse caret (▸/▾), items
indented underneath, only visible rows + a small buffer touch the DOM
(`buildFlatItems`/`indexAtOffset`/`renderWindow`, windowed over an
absolute-positioned spacer). Deliberately "dumb": it owns the DOM/
virtualization/expand-collapse state only, not what items exist or how
they're grouped/scored/filtered — the owner calls `setGroups(groups,
{searching, hasAnyRows})` whenever its data changes and supplies
`itemKey`/`itemName`/`rowDescription`/`emptyMessage`/`onSelect` hooks (same
split `ToolPalette` uses for widget-vs-state ownership). Default expand
state: a pseudo-group label starting with `--` (e.g. "-- Recently Used --")
starts expanded, an ordinary group starts collapsed, ANY group is force-
expanded while `searching` is true; a manual user toggle overrides the
default and persists for the instance's lifetime. This is the ONE real
tree implementation — `LibraryChooser`'s modal list and
`SymbolEditorScreen`'s always-visible Libraries pane both mount their own
`LibraryTreeList` instance rather than each building their own row list;
see that class's own doc comment for the reasoning (the user explicitly
pushed back on an earlier pass that only unified CSS class names between
those two, not the actual row-building code).

### `LibraryChooser.ts`
Abstract generic base class (`LibraryChooser<TItem>`) for a modal, grouped
library-item picker: search box wired to `TextScore`, a `LibraryTreeList`
instance for the row list itself, a "-- Recently Used --" MRU group
persisted to localStorage, and a live preview render session with
staleness-guarded async loading (an in-flight preview load checks
`requestId` against `this.previewRequestId` so a slow, superseded request
can't clobber a newer one's session state). A subclass supplies ~13 small
hooks for what actually differs between item kinds (`fetchRows`,
`itemKey`, `scoreFields`, `libraryGroupKey`, `loadPreviewContent`, etc.) —
see `SymbolChooser.ts`/`FootprintChooser.ts` for the two real
implementations, which keep only their genuine differences (SymbolChooser's
multi-unit placement flow; FootprintChooser's promise-returning picker +
fp-filter checkboxes) on top. New per-kind pickers (e.g. a future 3D-model
chooser) should extend this rather than writing a new modal-list-with-
search from scratch.

### `PreviewCamera.ts`
`fitPreviewCameraToContents(session, pad?)` — fits a `KicadRenderSession`'s
camera to the bounding box of everything currently hit-testable in its
scene, with padding. Shared by `SymbolChooser`'s preview, `FootprintChooser`
(via its own footprint-preview loader), and `SymbolEditorScreen`'s inline
preview — the same "frame what I just loaded" step all three needed.

### `SymbolChooser.ts` / `FootprintChooser.ts`
KiCad-style symbol/footprint pickers built on `LibraryChooser`. Look at
these before adding a new library-item chooser — the shared mechanics
belong in `LibraryChooser`, not copied again.

## Board-editor-specific (not yet generalized)

`BoardToolbar`-family panels (`BoardAuxToolbar.ts`, `BoardAppearancePanel.ts`)
and full-screen compositions (`HomeScreen.ts`, `ProjectOverviewScreen.ts`,
`SymbolEditorScreen.ts`, `UpdatePcbFromSchematic.ts`, `SymbolFieldsTable.ts`)
are screen/feature-specific, not reusable widgets — listed here for
completeness, not as extension points.
