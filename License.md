# Source provenance and third-party notices

This app intentionally follows KiCad behavior closely and, in a few places, uses direct algorithmic ports from the local KiCad source tree. This document is the audit trail so it is clear what was copied, translated, or adapted, and where it came from.

This audit is intentionally limited to code that was directly ported from KiCad source (GPLv3+), rather than general behavior matching or UI conventions.

## KiCad source tree reviewed

Local checkout inspected for attribution:

- `C:\Projects\Personal\Electronic\kicad`

## Direct KiCad-derived ports

| This project file | KiCad source file(s) | Port type | Notes |
|---|---|---|---|
| `shared/kicad-render/router/PnsHull.ts` | `pcbnew/router/pns_utils.cpp` | Direct algorithmic port | Port of `OctagonalHull`, `SegmentHull`, `ConvexHull`, and the `BuildHullForPrimitiveShape` logic. The file comment explicitly calls out the direct translation of the KiCad hull code. |
| `shared/kicad-render/router/PnsWalkaround.ts` | `pcbnew/router/pns_walkaround.cpp`, `pcbnew/router/pns_line.cpp` | Direct algorithmic port | Port of the interactive walkaround logic (`PNS::LINE::Walkaround`, `HullIntersection`, `SHAPE_LINE_CHAIN::Split`, and related graph/walk semantics). This is the clearest GPL-licensed derivative file in the project. |
| `shared/kicad-render/router/PnsOptimizer.ts` | `pcbnew/router/pns_optimizer.cpp`, `libs/kimath/src/geometry/direction_45.cpp` | Direct algorithmic port | Port of the simplification pass (`OPTIMIZER::mergeStep`, `OPTIMIZER::mergeFull`, `BuildInitialTrace`, and corner-cost logic). |
| `shared/kicad-render/paint/BoardZoneFill.ts` | `pcbnew/zone_filler.cpp`, `pcbnew/zone.cpp` | Faithful algorithmic translation | Port of the zone fill pipeline: outline processing, exclusion ring generation, edge/keepout handling, and final fill composition. The file explicitly notes it is a translation of the KiCad fill pipeline, with deferred features left unported. |
| `shared/kicad-render/paint/BoardZoneFill.ts` | `include/board_design_settings.h` | Default constant used as-is | The default copper-edge clearance constant `DEFAULT_COPPEREDGECLEARANCE` is taken from real KiCad stock defaults. |

## Additional third-party source material

This repository also includes upstream third-party code that is not copied from KiCad itself but still needs explicit attribution to stay legally clear.

### KiCanvas-derived renderer modules

`shared/kicad-render/README.md` states that a set of math/text modules in the renderer are derived from KiCanvas by Alethea Katherine Flowers and used under the MIT License.

Relevant files include:

- `shared/kicad-render/math/Angle.ts`
- `shared/kicad-render/math/Vec2.ts`
- `shared/kicad-render/math/Matrix3.ts`
- `shared/kicad-render/math/Camera2.ts`
- `shared/kicad-render/math/BBox.ts`
- `shared/kicad-render/text/Glyph.ts`
- `shared/kicad-render/text/StrokeGlyph.ts`
- `shared/kicad-render/text/StrokeFont.ts`

These are MIT-licensed derivative works of KiCanvas. See `shared/kicad-render/README.md` and the KiCanvas upstream LICENSE for the full text.

### Newstroke font data

`shared/kicad-render/text/NewstrokeGlyphs.ts` includes KiCad/Newstroke glyph data. The upstream notice in `shared/kicad-render/README.md` states that the font was originally licensed under CC0 1.0, amended with an MIT-like license, and the glyphs are licensed under the SIL Open Font License Version 1.1.

### Clipper2 port

`shared/clipper2-ts/src/*.ts` is a TypeScript port of Clipper2 and carries the Boost Software License 1.0. Each file carries a source-level notice for that license.

### KiCadParser / kicad-io package

`shared/kicad-io` is maintained as a separate package and ships with its own MIT license at `shared/kicad-io/LICENSE`.

## Importance of the list above

These are the files that are not just "inspired by KiCad" or "matching KiCad behavior"; they are direct code translations or direct algorithmic ports from KiCad's GPL-licensed implementation, or they are bundled upstream dependencies with their own license obligations. In practical terms, they should be treated as derivative work of their upstream sources and kept clearly attributable.

## Notes on scope

This audit intentionally excludes:

- Generic UI/interaction semantics that match KiCad without direct copying
- One-off constants or behavior notes that were confirmed against the KiCad source but not literally ported
- Standard build tooling (TypeScript, Vite, etc.) that is used as a project dependency rather than copied into the repo as source code

## Attribution statement

The direct KiCad-derived files above are derived from the KiCad source tree and therefore carry the same GPLv3+ provenance as the original upstream implementation. The project also incorporates KiCanvas-derived modules, Newstroke font data, Clipper2-TS code, and the shared `kicad-io` package, each with its own upstream notices and licensing terms. The project remains responsible for preserving these attributions as new ports or dependencies are added.
