# Unified Project Setup

## Objective

Add a third editor tab, **Project Setup**, beside **Schematic** and **PCB**. It
combines KiCad's Board Setup and Schematic Setup into one project-wide
workspace while preserving KiCad's setting names, defaults, validation,
serialization, and runtime behavior.

This is project data, not app-wide Preferences. Preferences continue to live
in `Settings.ts`/`localStorage`; Project Setup edits the open KiCad project and
must round-trip through desktop KiCad.

## Progress

Last updated: 2026-08-14

- [x] Read `apps/kicad-viewer/README.md` and `AGENTS.md` and confirm the app's
  project/session/storage boundaries.
- [x] Inventory the page trees built by KiCad's current Board Setup and
  Schematic Setup dialogs.
- [x] Inventory the current KiCad project JSON registrations and the supplied
  `CM5_MINIMA_2.kicad_pro` fixture.
- [x] Identify settings stored outside `.kicad_pro` and their ordering
  dependencies.
- [x] Audit current `kicad-io` support: project JSON is lossless passthrough;
  board layers and stackup parse, but do not yet expose a complete mutation
  surface; no Project Setup transaction spans all files yet.
- [ ] Phase 0 — fixtures, schema catalog, multi-file draft, validation, and
  persistence foundation. **In progress:** the lossless `.kicad_pro` draft,
  source-conflict check, aggregate validation, Apply/Revert, and adapter-backed
  save path are implemented; board/schematic/DRU participants remain.
- [x] Phase 1 — third tab and Project Setup workspace shell, including routed
  navigation, searchable KiCad page tree, planned-page states, dirty/leave
  handling, responsive layout, and renderer-session preservation.
- [ ] Phase 2 — shared Project pages. **Substantially complete:** Text
  Variables; Net Classes, net colors, patterns, multi-class direct assignments;
  Component Classes and all current condition kinds; impedance/time-domain
  Tuning Profiles including layer/via override rows; Bus Aliases; Net Chains;
  and pinned Libraries are implemented. Library-table sidecars and additional
  project path controls remain with Phase 6.
- [ ] Phase 3 — Schematic pages. **Substantially complete:** Formatting,
  Annotation, project Field Name Templates, BOM view/export presets, all
  serialized ERC rule severities, and the symmetric 12×12 Pin Conflicts Map
  are implemented. Desktop-KiCad bidirectional comparison, grouped severity
  descriptions/reset defaults, and downstream annotation/ERC/BOM consumers
  remain for the parity phase. The CM5 browser interaction pass is complete.
- [ ] Phase 4 — Board JSON-backed pages. **Substantially complete:** PCB text
  and graphics defaults, dimension formatting, global constraints,
  pre-defined track/via/differential-pair sizes, zone defaults, all three
  teardrop parameter sets, length-tuning patterns, and every serialized DRC
  severity are implemented. Runtime consumers and desktop-KiCad
  bidirectional comparison remain for the parity phase.
- [ ] Phase 5 — Board-file stackup/manufacturing pages. **Complete except
  desktop-KiCad parity:** the draft spans `.kicad_pro` and `.kicad_pcb`;
  Board Editor Layers, Physical Stackup, Board Finish, and Solder Mask/Paste
  are editable and persist together. Per-row dielectric thickness locks
  round-trip losslessly through KiCad's `(thickness N locked)` node,
  explicit "Add Dielectric"/"Remove" controls insert and delete dielectric
  rows with structural validation, and a board-touching Apply now reloads
  the live `KicadRenderSession` (preserving camera/zoom) so the PCB canvas
  reflects the change immediately. Desktop-KiCad bidirectional comparison
  remains, out of scope for this slice per explicit user direction.
- [ ] Phase 6 — custom rules, embedded files, and imports. **In progress:**
  the `.kicad_dru` Custom Rules page is implemented (lossless free-text
  editor, matching real KiCad's own primary editor for this file). Board and
  Schematic Embedded Files are also implemented: `.kicad_pcb`/`.kicad_sch`
  `(embedded_files (file ...))` blocks parse/write losslessly
  (`KicadElementEmbeddedFiles`/`KicadElementEmbeddedFile` in kicad-io), a
  hand-ported zero-dependency zstd decoder (`shared/zstd-ts/`, RFC 8878,
  ground-truth verified against Node's real `zlib.zstdCompressSync`) and MMH3
  checksum port (`EmbeddedFileHash.ts`, verbatim copy of the already-shipped
  `api/kicadEmbedStep.ts` implementation) back the pages, and both pages list
  every embedded file (name/type/size/checksum) with Add (multiple files,
  written as uncompressed-but-spec-valid Raw_Block frames — no LZ/entropy
  encoder needed to write, only to read arbitrary real files) and per-row
  Download (decompresses, checksum-verifies, triggers a browser save) and
  Remove actions. Cross-project import remains.
- [ ] Phase 7 — editor/runtime integration and parity verification.

### Implementation checkpoint — 2026-08-14

- Added `project-settings` as a third routed editor view without widening the
  renderer's `DocumentKind` type.
- Added `ProjectSetupController` and `ProjectSettingsDraft`; opening the tab is
  non-mutating, and Apply replaces/saves project JSON only after validation
  and a live-source fingerprint check.
- Added complete editing for project text variables and the fixture's net
  class schema: routing dimensions, schematic widths/style, priority, colors,
  tuning profile, pattern assignments, multi-class direct net assignments,
  and per-net colors.
- Added the remaining JSON-backed shared pages after checking the current
  KiCad implementations: bus aliases, net-chain classes, pinned libraries,
  component-class assignments (`ALL`/`ANY` plus all seven condition kinds),
  and schema-1 tuning profiles with propagation-layer and via-override rows.
- Editing a versioned owner upgrades only that changed owner to KiCad's current
  supported schema version; untouched owners keep their original version and
  content.
- The PCB router now reads Default net-class track width, via diameter, and
  via drill at placement time, so applied project settings take effect without
  recreating the controller or reopening the board.
- Production type-check and build pass. Browser verification used the supplied
  CM5 project imported as a zip: draft dirty state, invalid-via validation,
  Revert, Apply, persistence across reload, cross-page duplicate validation,
  Project Setup ↔ PCB switching, and a clean browser console all passed.
- The later shared-page additions pass type-check and production build; their
  focused browser interaction pass remains the next verification checkpoint.
- Added all `.kicad_pro`-backed Schematic Setup pages after mapping
  `schematic_settings.cpp`, `erc_settings.cpp`, and the corresponding KiCad
  panels. Formatting includes drawing defaults, connection grid, ratios,
  intersheet references, operating-point formatting, and output paths.
- Annotation now edits KiCad's exact unit-separator/first-ID character codes,
  X/Y sort order, three numbering methods, start number, and reference reuse.
  Field templates preserve the exact `name`/`visible`/`url` records and order.
- BOM editing covers the current view, saved view presets, ordered fields,
  grouping/filtering/sorting flags, export filename, current export format,
  and saved format presets. ERC severity rows are generated from every key in
  the loaded project, preserving future keys, and the pin map uses KiCad's
  exact numeric states and default matrix with mirrored edits.
- The Phase 3 implementation passes TypeScript type-check and production
  build. Browser verification with the supplied CM5 fixture covered all six
  pages, clean-on-open behavior, 48 ERC severity rows, all 78 editable cells
  in KiCad's lower-triangle pin map, cell cycling, Revert, and a clean browser
  console. Desktop-KiCad comparison is still required before declaring full
  parity.
- Added all schema-2 `.kicad_pro` Board Setup pages after mapping
  `board_design_settings.cpp` and the corresponding PCB setup panels. The
  draft edits only `board.design_settings`, upgrades that owner to schema 2
  only when changed, and preserves unknown current/future keys.
- Board defaults cover the four KiCad layer classes, board outline/courtyard
  widths, footprint-default flags, and the default through-hole pad.
  Formatting covers every stored dimension option and converts KiCad's raw
  arrow/extension internal units to UI millimeters at the form boundary.
- Constraints cover all schema-2 project-owned rule floors and bounds.
  Solder-mask expansion/min-width and paste margins are intentionally not
  duplicated here because KiCad migrated them to `.kicad_pcb`; they remain
  with Phase 5's Solder Mask/Paste page.
- Pre-defined routing sizes preserve KiCad's zero-valued net-class row and
  validate via drill/diameter and differential-pair gap invariants. Zone,
  teardrop, and length-tuning pages expose every serialized fixture field.
  DRC severity rows are generated from the loaded project and preserve
  unknown future severity values.
- Phase 4 passes TypeScript type-check and production build. Browser
  verification with the supplied CM5 fixture covered all eight pages,
  clean-on-open behavior, three routing-size tables, three teardrop parameter
  groups, three tuning-pattern groups, all 63 serialized DRC severities,
  constraint validation, Apply, and persistence across reload with a clean
  console. Desktop-KiCad comparison and runtime consumption remain before
  full parity.
- Added a cloned `.kicad_pcb` root to `ProjectSettingsDraft`. Opening setup is
  non-mutating; dirty state, validation, revision checks, Revert, and Apply now
  cover project JSON and the board file as one draft. Apply writes only changed
  owners, updates the live board after both saves succeed, and attempts a board
  rollback if a following project-file write fails.
- Board Editor Layers uses KiCad's fixed layer IDs and canonical names, edits
  aliases and copper electrical types, supports every even copper count from 2
  through 32, synchronizes copper/dielectric stackup rows, and refuses to
  remove a copper layer still referenced by board items.
- Physical Stackup edits type, thickness, material, color, epsilon R, and loss
  tangent for the loaded stackup, calculates its total, compares it with
  `general.thickness`, and can synchronize the declared board thickness.
  Numeric S-expression serialization now retains six decimal places instead
  of truncating real fabrication values such as 0.0994 mm and 0.0152 mm.
- Board Finish follows the current KiCad writer: quoted copper finish,
  dielectric-constraints boolean, literal `edge_connector` values, and the
  optional edge-plating flag. The legacy `castellated_pads` node is not exposed
  because current KiCad only accepts and discards it for compatibility.
- Solder Mask/Paste maps the exact current setup nodes for mask expansion,
  minimum mask width, paste clearance and ratio, footprint mask bridges, plus
  KiCad 10 front/back tenting, covering, and plugging. Capping/filling remain
  per-pad/padstack properties rather than misleading board-global controls.
- Phase 5 currently passes TypeScript type-check and production build. Browser
  verification on the imported CM5 six-layer fixture confirmed exact source
  precision, clean-on-open behavior, validation, multi-page dirty state,
  Apply, and persistence across reload for finish, edge plating, mask
  expansion, paste ratio, and front-side via covering with a clean console.
- No app-level automated test runner exists yet; pure draft/validation tests
  should be added with Phase 0's fixture harness rather than introducing a
  second ad-hoc runner for this slice.
- Closed out Phase 5's three remaining items (desktop-KiCad comparison stays
  out of scope per explicit user direction). `KicadElementThickness` now
  parses and re-emits KiCad's optional trailing `locked` literal without
  weakening `KicadElementNumeric.afterParse`'s single-attribute check for
  every other numeric subclass; `KicadElementLayer` exposes
  `get/setThicknessLocked()`.
- `KicadElementStackup` gained `insertLayer(index, name)`/`removeLayerAt(index)`;
  `ProjectSettingsDraft` uses them for `insertDielectricLayer`/
  `removeDielectricLayer` with KiCad-consistent core-layer defaults, and
  `validateBoardFileSettings()` now flags a dielectric-row/copper-layer-count
  mismatch as a blocking `ValidationIssue`.
- The Physical Stackup page has a "Locked" checkbox column plus per-row
  "Insert Dielectric Below"/"Remove" actions and a page-level "Add
  Dielectric" button, all wired through the new draft methods.
- `MainApp.ts`'s `ProjectSetupController.onApplied` callback now reloads the
  active `KicadRenderSession` via `loadBoardText(..., { preserveView: true })`
  whenever the applied draft touched the board file, fixing the case where
  the PCB tab was already open before Apply and previously kept showing the
  pre-Apply board until a manual reopen.
- Added kicad-io fixture round-trip tests for the locked/unlocked thickness
  node and for `insertLayer`/`removeLayerAt`; the full local suite passes
  (66/66 in the new/changed spec file). TypeScript type-check and production
  build both pass. A headless browser pass against the real CM5 project
  fixture exercised Add/Remove/Lock on Physical Stackup and a copper-layer-
  count change applied while the PCB tab was already open, confirming no
  console errors on either flow.
- Started Phase 6 with Custom Rules (`.kicad_dru`). Confirmed against the
  real KiCad checkout that Board Setup > Custom Rules is itself a raw text
  editor over this exact file (`pcbnew/dialogs/panel_setup_rules.cpp`, a
  Scintilla control with an on-demand Compile button) rather than a
  structured form, so a lossless free-text passthrough is the correct match
  for KiCad's own authoring model here, not a placeholder pending a
  structured editor.
- Added `KicadDesignRulesFile` (`shared/kicad-io/src/Project/`), mirroring
  `KicadProjectFile`'s load/save skeleton minus JSON parsing.
  `KicadProject.openFromProjectRoot` now probes for the optional
  same-basename `.kicad_dru` sibling via try/catch (every fs adapter in this
  app throws on a missing file, never returns falsy); `createNew` seeds an
  unloaded instance for symmetry; `saveAll` only writes it when it already
  existed on disk or now has real content, so an untouched project never
  gains a spurious empty `.kicad_dru`.
- `ProjectSettingsDraft` gained `.kicad_dru` as a third, independent
  participant using the exact same whole-file-text-diff dirty-tracking,
  conflict-check, and try/catch-rollback shape the board participant
  already uses — `apply()` now saves/rolls back rules, board, and project
  JSON as one transaction.
- The Custom Rules page is a single free-form textarea (bound to
  `draft.rulesText`/`setRulesText`), with a hint shown when no `.kicad_dru`
  exists yet for the project. Deliberately no grammar/syntax validation this
  pass — the Data Ownership table's "lossless text document first;
  syntax-aware validation and editor diagnostics second" phasing stays
  intentional, not deferred by omission.
- Fixed a re-render gap caught during browser verification: the "no file
  yet" hint is computed from original (pre-apply) state, so a successful
  Apply that creates the first `.kicad_dru` for a project left the stale
  hint showing until the user navigated away and back. `apply()` now
  re-renders the Custom Rules page specifically after a successful apply;
  every other page edits its fields in place already and needed no change.
- Added kicad-io test coverage: `kicadDesignRulesFile.test.ts` (load/save
  round-trip, including the "file doesn't exist" throw path preserving
  `.path` for a later create), `kicadProjectDesignRules.test.ts`
  (`openFromProjectRoot`'s sibling-discovery try/catch, `createNew`,
  `saveAll`'s no-spurious-file guarantee), and
  `projectSettingsDraftDesignRules.test.ts` (dirty tracking, reset, apply's
  conditional save, the "adapter can't save" and "changed outside this tab"
  error paths) — 16 new tests, all passing, no regressions in the existing
  suite.
- Type-check and production build pass. Browser verification against the
  supplied CM5 project (imported via the IndexedDB-backed zip-import path,
  which is writable, unlike a raw zip-backed read-only open) confirmed:
  page renders with the correct "no file yet" hint on a project with no
  `.kicad_dru`; typing dirties the draft; Apply creates the file, persists
  it, and the hint correctly disappears; a full page reload (via Home →
  reopen) shows the persisted rule text; editing again dirties the draft a
  second time; Revert restores the original text and clears dirty state;
  browser console stayed clean (the one console error present throughout —
  "Failed to fetch a worker script" — predates this change and is unrelated
  to Custom Rules).

## KiCad source baseline

The product specification for this work is the local checkout at
`C:\Projects\Personal\Electronic\kicad`, currently reporting
`10.99.0-2172-gfd4aa7e2d8`. The primary source files inspected are:

- `pcbnew/dialogs/dialog_board_setup.cpp`
- `eeschema/dialogs/dialog_schematic_setup.cpp`
- `pcbnew/board_design_settings.cpp`
- `eeschema/schematic_settings.cpp`
- `eeschema/erc/erc_settings.cpp`
- `common/project/project_file.cpp`
- `common/project/net_settings.cpp`
- `common/project/component_class_settings.cpp`
- `common/project/tuning_profiles.cpp`
- `pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp`

The supplied project is the initial compatibility fixture:
`C:\Users\Kaminaris\Downloads\CM5_MINIMA_REV2-main\CM5_MINIMA_2.kicad_pro`.
It uses project schema version 3, board design-settings schema version 2,
schematic schema version 1, and net-settings schema version 5.

The local KiCad checkout is newer than the fixture. Newer keys must be
supported when understood and preserved unchanged when not understood.

## Non-negotiable compatibility rules

1. **Lossless-by-default.** Opening and applying one setting must not delete,
   reorder semantically significant data, or replace unknown current/future
   KiCad keys with app defaults.
2. **No parallel shadow settings.** Controls read from and commit to KiCad's
   real data paths. Project settings never get copied into app Preferences.
3. **Multiple files form one draft.** Project Setup can touch `.kicad_pro`,
   `.kicad_pcb`, `.kicad_sch`, and `.kicad_dru`; validation and commit operate
   on the whole project draft.
4. **Units follow the owning format.** PCB JSON values are generally mm;
   schematic values include KiCad-specific integer/grid conventions. UI unit
   conversion must happen at the form boundary, not by normalizing stored
   data opportunistically.
5. **KiCad ordering dependencies are retained.** Board Editor Layers is
   applied before Physical Stackup because stackup validity depends on the
   enabled copper-layer set. Net classes precede consumers that reference
   them; embedded-file deletion waits until all references validate.
6. **Read-only projects stay read-only.** Zip imports show settings but disable
   editing, Apply, imports, and embedded-file mutation with a clear reason.
7. **A visible control must work.** A page may land incrementally, but it must
   not present inert fields as implemented. Unsupported controls are marked
   read-only with an explicit compatibility note until their phase lands.

## Data ownership

The unified UI is one workspace, but KiCad does not store it as one document.

| Owner | Settings | Current app support | Required work |
|---|---|---|---|
| `.kicad_pro` | Board design defaults/constraints/severities/sizes/teardrops/tuning; schematic formatting/annotation/BOM/ERC; net classes; component classes; text variables; bus aliases; project metadata | `KicadProjectFile.raw` preserves arbitrary JSON and has a few read accessors | Add typed path adapters, defaults, validators, and immutable draft/patch support without replacing `raw` |
| `.kicad_pcb` | Enabled/named board layers, physical stackup, finish, impedance flag, mask/paste setup, board embedded files | Layers and stackup parse; stackup has partial setters; generic S-expression nodes preserve other setup fields | Complete typed getters/setters, structural edits, layer remap validation, embedded-file parsing, and board-wide setup accessors |
| `.kicad_sch` | Schematic embedded files and document-resident data referenced by setup | Generic S-expression round-trip exists | Add schematic-root embedded-file access and safe file mutation |
| `.kicad_dru` | Board custom rules | No project-owned custom-rule document | Add a lossless text document first; syntax-aware validation and editor diagnostics second |

Saving should remain explicit. `JSON.parse`/`JSON.stringify` already means the
first `.kicad_pro` save may have a formatting-only diff; Project Setup must
never trigger that save merely by opening the tab.

## Unified navigation tree

Shared data appears once under **Project**, even where desktop KiCad exposes
the same data through both setup dialogs. Board- and schematic-specific pages
keep KiCad's names and relative ordering.

```text
Project Setup
├─ Project
│  ├─ Net Classes
│  ├─ Component Classes
│  ├─ Tuning Profiles
│  ├─ Text Variables
│  ├─ Bus Alias Definitions
│  ├─ Net Chains
│  └─ Libraries
├─ Schematic
│  ├─ General
│  │  ├─ Formatting
│  │  ├─ Annotation
│  │  ├─ Field Name Templates
│  │  └─ BOM Presets
│  ├─ Electrical Rules
│  │  ├─ Violation Severity
│  │  └─ Pin Conflicts Map
│  └─ Schematic Data
│     └─ Embedded Files
└─ Board
   ├─ Board Stackup
   │  ├─ Board Editor Layers
   │  ├─ Physical Stackup
   │  ├─ Board Finish
   │  └─ Solder Mask/Paste
   ├─ Text & Graphics
   │  ├─ Defaults
   │  └─ Formatting
   ├─ Design Rules
   │  ├─ Constraints
   │  ├─ Pre-defined Sizes
   │  ├─ Zones
   │  ├─ Teardrops
   │  ├─ Length-tuning Patterns
   │  ├─ Custom Rules
   │  └─ Violation Severity
   └─ Board Data
      └─ Embedded Files
```

`Tuning Profiles` is shown once under Project because current KiCad stores it
as a project-level collection even though board tools consume it. Project
libraries initially cover pinned symbol/footprint libraries and project
paths; library-table editing remains a separate file-format task if a
`sym-lib-table`/`fp-lib-table` is present.

## Page coverage matrix

| Page | KiCad storage | First complete phase | Runtime consumer |
|---|---|---:|---|
| Project / Net Classes | `net_settings` in `.kicad_pro` | 2 | PCB router widths/vias/clearance; schematic wire/bus styling; net assignment |
| Project / Component Classes | `component_class_settings` | 2 | Rule matching and future component-class assignment |
| Project / Tuning Profiles | `tuning_profiles` | 2 | Future length/diff-pair tuning tools |
| Project / Text Variables | top-level `text_variables` | 2 | Schematic/PCB text-variable expansion |
| Project / Bus Alias Definitions | schematic/project bus aliases | 2 | Schematic bus parser and labels |
| Project / Net Chains | current `net_settings` chain data | 2 | Rule matching and connectivity inspection |
| Project / Libraries | `libraries`, project paths, table sidecars when supported | 2/6 | Symbol/footprint chooser resolution |
| Schematic / Formatting | `schematic.drawing` and connection grid | 3 | New graphics/text defaults and schematic renderer |
| Schematic / Annotation | `schematic` annotation keys | 3 | Future annotate command and reference allocation |
| Schematic / Field Name Templates | `schematic.drawing.field_names` | 3 | Symbol properties and newly placed symbols |
| Schematic / BOM Presets | schematic BOM settings/presets/format presets | 3 | BOM export UI |
| Schematic / Violation Severity | `erc.rule_severities` | 3 | ERC engine/results filtering |
| Schematic / Pin Conflicts Map | `erc.pin_map` | 3 | ERC pin-pair severity lookup |
| Schematic / Embedded Files | `.kicad_sch` | 6 | Images/fonts/worksheets and document packaging |
| Board / Board Editor Layers | `.kicad_pcb` `(layers ...)` | 5 | Renderer, active layer, routing, plotting |
| Board / Physical Stackup | `.kicad_pcb` `(setup (stackup ...))` | 5 | Board thickness, 3D/material data, impedance metadata |
| Board / Board Finish | `.kicad_pcb` stackup/setup | 5 | Fabrication output metadata |
| Board / Solder Mask/Paste | `.kicad_pcb` setup | 5 | Pad/mask/paste geometry and DRC |
| Board / Defaults | `board.design_settings.defaults` | 4 | Newly created tracks, zones, text, graphics, dimensions, pads |
| Board / Formatting | board text/dimension formatting settings | 4 | New PCB text/dimensions and property defaults |
| Board / Constraints | `board.design_settings.rules` | 4 | Router validation and DRC constraint floors |
| Board / Pre-defined Sizes | track/via/diff-pair arrays | 4 | Routing size selectors and hotkeys |
| Board / Zones | zone defaults | 4 | Future zone creation/refill |
| Board / Teardrops | teardrop options/parameters | 4 | Future teardrop generation |
| Board / Length-tuning Patterns | tuning pattern settings | 4 | Future tuning tools |
| Board / Custom Rules | `.kicad_dru` | 6 | DRC and interactive-router constraint evaluation |
| Board / Violation Severity | board design rule severities | 4 | DRC results filtering |
| Board / Embedded Files | `.kicad_pcb` | 6 | 3D models/fonts/datasheets and board packaging |

Every page is in scope for storage and editing. Runtime consumers that do not
exist yet must still read/write valid KiCad data, and the plan records their
integration rather than faking immediate behavior.

## Architecture

### Third editor view

Extend the editor view discriminator from `schematic | board` to
`schematic | board | project-settings`. Project Setup is available only when
a project context is open. It uses the existing project header and breadcrumb
but replaces the canvas, canvas toolbars, and Appearance/Properties panes with
a full-height setup workspace:

- left: searchable, collapsible navigation tree;
- center: active page with KiCad-like groups and tables;
- header/footer actions: **Apply**, **Revert**, **Import Settings**, and dirty
  state; pages may add narrowly scoped actions such as stackup adjustment;
- narrow layouts collapse navigation into a drawer without converting the
  workspace to a modal.

Switching tabs does not destroy the renderer or editor session. A dirty setup
draft remains in memory when switching to PCB/Schematic. Closing/switching the
project prompts to Apply or Discard. Browser back/forward restores the active
setup page through an optional route field such as `settingsPage`.

### Controller boundary

Add a `ProjectSetupController` under `src/project-setup/` with narrow injected
dependencies. `MainApp.ts` remains the composition root. Do not put the large
form state into `AppState`, and do not let individual pages call
`KicadProjectFile.raw` or filesystem adapters directly.

Suggested layout:

```text
src/project-setup/
  ProjectSetupController.ts
  ProjectSettingsDraft.ts
  ProjectSettingsSchema.ts
  ProjectSettingsValidation.ts
  ProjectSettingsCommit.ts
  pages/
    project/
    schematic/
    board/
  controls/
    UnitInput.ts
    EditableTable.ts
    SeverityTable.ts
    PinConflictMatrix.ts
```

Pages implement a small contract: render from typed draft state, write a
patch, validate, report dirty paths, and react to dependent changes. The
controller owns page lifetime, navigation, aggregate validation, apply,
revert, import, and leave guards.

### Draft and commit model

`ProjectSettingsDraft` snapshots all participating source documents on entry:

- deep-cloned `.kicad_pro` raw JSON;
- cloned board and schematic S-expression roots;
- original `.kicad_dru` text plus parsed diagnostics when present;
- source revision/text fingerprints to detect a conflicting editor mutation.

Typed adapters sit over this draft. They must create only the missing parent
objects necessary for an edited field. Untouched subtrees retain their exact
values. Arrays with identity (`classes`, layers, presets, profiles) use stable
keys rather than UI row indexes.

Apply is a two-step transaction:

1. validate every dirty page and cross-page invariant without touching the
   live project;
2. commit all document changes to the live `KicadProject`, synchronize the
   active render session, and then use the project's existing save adapters.

Folder-backed projects write all changed files. In-memory project state is
updated even before the explicit Save Project operation so switching editor
tabs immediately reflects settings. If any write fails, retain the dirty
draft and report which files succeeded; Phase 0 should add adapter-level
temporary-file/replace support where the browser API permits it. Zip-backed
projects never enter the commit path.

### Schema catalog

Do not model the entire project as one enormous TypeScript interface. Build
small typed schemas grouped by KiCad owner and page:

- board defaults, constraints, sizes, zones, teardrops, tuning, severities;
- schematic formatting, annotation, fields, BOM;
- ERC severities and 12×12 pin map;
- net classes, assignments/patterns/colors/chains;
- component classes and tuning profiles;
- project text variables, aliases, libraries, paths;
- board S-expression setup/layers/stackup/mask/paste;
- embedded file records and custom-rule text.

Each field descriptor carries its JSON/S-expression path, value kind, storage
unit, KiCad default for the source schema version, bounds/options, and a
formatter. This catalog drives form controls, reset-to-default behavior, and
focused tests, but does not generate page layout automatically.

## Implementation phases

### Phase 0 — compatibility foundation

- Copy the supplied complete project into test fixtures together with smaller
  two-layer and blank-project fixtures. Add a current-KiCad fixture generated
  by the local checkout so schema 10.99 additions are exercised.
- Add untouched and one-field-change round-trip tests for `.kicad_pro`, board
  setup, schematic embedded files, and `.kicad_dru` text.
- Introduce typed project JSON path adapters over `KicadProjectFile.raw` with
  cloning, patching, default lookup, and unknown-key preservation.
- Complete board-root accessors for layers, general thickness, setup,
  stackup, mask/paste values, finish, impedance flag, and embedded files.
- Add safe structural operations for stackup rows and board layers. Preserve
  layer IDs and KiCad's canonical copper ordering.
- Add project discovery/load/save for optional same-basename `.kicad_dru` and
  library-table sidecars without making them mandatory.
- Implement `ProjectSettingsDraft`, aggregate validation, dirty-path tracking,
  revision conflict detection, and commit/revert.
- Define the full schema catalog from the inspected KiCad source. Record
  explicit unsupported source fields instead of silently omitting them.

**Exit:** changing one field in each owner produces only the expected semantic
diff; desktop KiCad opens all results without migration or repair warnings.

### Phase 1 — Project Setup workspace

- Add the third top tab and route state.
- Add a Project Setup root in `index.html` and scoped styling matching the
  existing KiCad-like dark/light themes.
- Build navigation tree, page host, search/filter, dirty markers, Apply,
  Revert, keyboard focus order, and validation summary.
- Add leave/project-close guards and read-only state.
- Preserve live schematic/PCB sessions across settings-tab switches.
- Add reusable unit input, checkbox/radio group, editable table, severity row,
  and matrix controls with accessible keyboard operation.

**Exit:** all pages are navigable, but only pages completed in later phases
are editable. Switching tabs is instant and does not reset zoom, selection,
or an unapplied setup draft.

### Phase 2 — shared Project pages

- Net Classes: all PCB and schematic class fields, priority, colors,
  assignments/patterns, default-class protections, duplicate-name checks.
- Component Classes: definitions and rule-facing membership data available in
  the current schema.
- Tuning Profiles: single-ended, differential-pair, and skew parameters.
- Text Variables: add/edit/remove with KiCad name validation and live preview.
- Bus Alias Definitions and Net Chains: editable ordered tables with reference
  validation.
- Libraries: pinned symbol/footprint libraries and project path fields first;
  library-table sidecars after their lossless parser is available.

**Exit:** values round-trip through the supplied project and a fresh KiCad
project. Existing renderer/router consumers refresh without reopening.

### Phase 3 — Schematic Setup

- Formatting: default line/text sizes, pin/junction/hop sizes, label ratios,
  dashed ratios, intersheet references, operating-point overlay, and
  connection grid.
- Annotation: unit notation, X/Y sort, numbering scheme/start, reference
  reuse, separator and first subpart ID.
- Field Name Templates: field names, visibility, and placement flags.
- BOM Presets: editable preset and export-format collections, filename and
  field ordering/filtering options.
- ERC Violation Severity: all known keys, grouped like KiCad, with Reset.
- Pin Conflicts Map: KiCad's 12×12 matrix, symmetry behavior, keyboard
  navigation, per-cell severity legend, and Reset.

**Exit:** compare every value against Schematic Setup after opening the saved
fixture in desktop KiCad; change values in KiCad and confirm this app reads
them identically.

### Phase 4 — Board JSON settings

- Text & Graphics Defaults and Formatting.
- Design Rules Constraints, including all minimum clearances/widths/drills,
  silk/groove/text limits, copper-edge and mask-to-copper rules, and maximum
  geometric error.
- Pre-defined track, via, microvia, and differential-pair sizes.
- Zone defaults and external-fillet option.
- Teardrop global options and per-target parameter sets.
- Length-tuning pattern defaults.
- Board DRC Violation Severity and exclusions display.

Where an editor tool already exists, wire the setting immediately: routing
width/via presets, clearance floors, default text/graphics, and grid-sensitive
values must update without reopening the project. Pages for not-yet-existing
zone/tuning/DRC engines still provide valid storage editing.

**Exit:** all `board.design_settings` values in the supplied project are
represented, editable, resettable using KiCad defaults, and losslessly saved.

### Phase 5 — Board stackup and manufacturing setup

- Board Editor Layers: enabled layers, names, aliases, and copper layer type.
  Enforce KiCad layer IDs/count/order and detect objects that would be left on
  a disabled layer before Apply.
- Physical Stackup: copper count, dielectric rows, material, type, thickness,
  color, epsilon R, loss tangent, thickness locks, impedance-controlled flag,
  add/remove dielectric, computed total board thickness, and adjust dielectric
  thickness action.
- Board Finish: finish and related fabrication metadata present in current
  KiCad setup nodes.
- Solder Mask/Paste: clearances, minimum web/width, tenting/capping/filling and
  paste ratio where supported by the file version.
- Apply Board Editor Layers before Physical Stackup, matching KiCad's dialog
  transfer order.
- Refresh board painter layer lists, Appearance panel, active routing layer,
  and 3D/geometry consumers after commit.

**Exit:** reproduce the supplied six-layer stackup, compare every row in
desktop KiCad, then add/remove a dielectric and verify both applications
compute the same thickness and reload the same stack.

### Phase 6 — sidecars, embedded files, and import

- Custom Rules: lossless `.kicad_dru` editor with syntax highlighting,
  diagnostics, search, and KiCad grammar/version validation. Preserve comments
  and formatting on untouched content.
- Board and Schematic Embedded Files: list (name/type/size/checksum), add
  (multiple files at once), download (decompress + checksum-verify), and
  remove. **Done** — hand-ported zstd decoder (`shared/zstd-ts/`) and MMH3
  checksum (`EmbeddedFileHash.ts`) back it; write side emits spec-valid
  uncompressed Raw_Block frames (no LZ/entropy encoder needed to write).
  No reference tracking on removal, matching real KiCad's own
  `panel_embedded_files.cpp` dialog, which doesn't check references either.
  Not done: in-place replace (remove + re-add covers it) and
  referenced/unreferenced display.
- Import from another board: choose a `.kicad_pcb` and selectively copy board
  layers/stackup/mask-paste plus project board-design settings, matching
  KiCad's applicable pages.
- Import from another project: choose `.kicad_pro` and selectively copy shared
  and schematic settings. Never copy project identity/sheet paths by default.
- Add per-domain Reset to KiCad Defaults; avoid a destructive global reset
  unless the user explicitly confirms the full affected-page list.

**Exit:** custom-rule comments survive edits; embedded-file checksums match;
selective imports make the same settings visible in desktop KiCad.

### Phase 7 — behavior integration and parity audit

- Make all existing/new editor commands consume project defaults and classes,
  including routing presets, netclass assignment, new-object defaults, text
  variables, schematic fields, and annotation allocation.
- Feed constraints, severity maps, pin conflicts, component classes, net
  chains, tuning profiles, and custom rules into DRC/ERC/router work as those
  engines land. Storage completion is not falsely marked as behavioral
  completion.
- Test concurrent mutations: change setup, edit board, switch tabs, undo board
  edits, Apply setup, Save Project, reload.
- Run full keyboard/accessibility and responsive-layout passes.
- Perform bidirectional desktop-KiCad comparison on the supplied project, a
  two-layer project, a blank project created here, and a current-10.99 project.

**Exit:** every visible setting either has verified KiCad-equivalent behavior
or an explicit tracked downstream-engine dependency; all files reopen cleanly
in desktop KiCad and reopen identically here.

## Validation rules requiring special care

- Copper layer count, IDs, names, enabled states, and stackup rows must agree.
- Total stack thickness and board general thickness must agree after Apply.
- Net class names are unique; Default exists and cannot be removed; all
  assignments, patterns, chains, profiles, and component classes resolve.
- Via drill is smaller than via diameter; microvia and differential-pair
  values satisfy KiCad bounds; numeric values cannot be negative unless KiCad
  explicitly permits them.
- Mask/paste ratio and clearance constraints follow KiCad's permitted ranges.
- Text-variable and field-template names follow KiCad naming rules.
- The pin-conflict matrix remains a valid 12×12 table and honors KiCad's
  mirrored-cell behavior.
- Severity values are limited to KiCad's known enum while unknown future
  severity keys/values remain preserved.
- Removing a board layer, net class, profile, alias, or embedded file reports
  every affected reference before the change can commit.

## Testing and verification

Automated tests belong primarily in `shared/kicad-io` for format mutation and
round-tripping, with focused app tests added for pure draft/validation logic.
For every page family:

1. load an untouched fixture and assert no dirty paths/no save;
2. modify one value and assert a minimal semantic diff;
3. add, reorder, and remove table rows where allowed;
4. preserve unknown keys/nodes and optional files;
5. reject invalid cross-page combinations without touching live state;
6. type-check and run `yarn build`;
7. perform the mandatory browser pass with a folder-backed project;
8. save and open the result in the local desktop KiCad build;
9. modify the same value in KiCad, reopen here, and compare.

Do not claim a page complete based only on rendering or JSON output. Its
values must be observed in desktop KiCad and, where a consumer exists in this
app, must alter that consumer's behavior.

## First implementation slice

Begin with Phase 0 plus a narrow Phase 1/2 vertical slice:

1. third tab and persistent workspace shell;
2. multi-file project draft with `.kicad_pro` only enabled initially;
3. Project / Text Variables;
4. Project / Net Classes, including current router preset refresh;
5. Apply/Revert, read-only handling, leave guard, and round-trip tests.

This slice proves routing, ownership, table editing, validation, persistence,
runtime refresh, and KiCad interoperability before duplicating the same form
infrastructure across several dozen pages.
