# KiCad-compatible Zint WASM builder

This is intentionally a manual build step. It pulls KiCad revision
`fd4aa7e2d8229b53801c7cfe618d8e110c41263b`, whose bundled Zint reports
version 2.15.0.9, then produces the browser artifacts in `public/vendor/zint`.

From `apps/kicad-viewer`:

```sh
docker compose -f tools/zint-wasm/compose.wasm.yml run --build --rm zint-wasm
```

Commit the resulting `zint.mjs`, `zint.wasm`, and `LICENSE.zint-GPLv3` with
the renderer change so deployed GitHub Pages builds are self-contained. No
host compiler, Emscripten installation, or CI job is required.
