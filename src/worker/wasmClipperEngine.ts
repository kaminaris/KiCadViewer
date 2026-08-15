import type { ClipperEngine } from '@kicad-render/paint/ClipperEngine';
import type { Path, Paths }   from '@clipper2-ts/core';

import Clipper2ZFactory from 'clipper2-wasm/dist/es/clipper2z.js';
import clipper2zWasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url';

/**
 * Wraps clipper2-wasm (real Clipper2 C++ compiled to WASM) behind the same
 * ClipperEngine interface the pure-TS port implements — see
 * @kicad-render/paint/ClipperEngine's header comment for why the loading
 * step lives here (Vite-specific .wasm asset resolution via `?url`) rather
 * than in the bundler-agnostic shared/kicad-render package.
 *
 * clipper2-wasm's FillRule/ClipType/JoinType/EndType enum VALUES are
 * numerically identical to clipper2-ts's own (both are faithful mirrors of
 * the same real Clipper2 C++ enums — confirmed by reading both sources'
 * declared orderings, not assumed), and its own .d.ts documents each enum
 * value as a plain `{value: N}` object with no extra binding state (unlike
 * its real class instances — Path64/Paths64/Point64 — which all need
 * `.delete()`). So a caller's plain clipper2-ts enum number can be wrapped
 * directly into that shape with no translation table.
 */
function wrapEnumValue(value: number): { value: number } {
	return { value };
}

function toWasmPath(path: Path, M: any): any {
	const flat: number[] = [];
	for (const p of path) {
		flat.push(p.x, p.y);
	}
	return M.MakePath64(flat);
}

function toWasmPaths(paths: Paths, M: any): any {
	const wasmPaths = new M.Paths64();
	for (const path of paths) {
		wasmPaths.push_back(toWasmPath(path, M));
	}
	return wasmPaths;
}

/** Reads a WASM Paths64 back into plain {x,y} numbers and deletes every
 *  embind object along the way (Path64/Point64 both need explicit
 *  `.delete()` — only the returned plain data survives). Does NOT delete
 *  `wasmPaths` itself — the caller passed it in and owns its lifetime. */
function fromWasmPaths(wasmPaths: any): Paths {
	const result: Paths = [];
	const count = wasmPaths.size();
	for (let i = 0; i < count; i++) {
		const wasmPath = wasmPaths.get(i);
		const path: Path = [];
		const pointCount = wasmPath.size();
		for (let j = 0; j < pointCount; j++) {
			const pt = wasmPath.get(j);
			path.push({ x: Number(pt.x), y: Number(pt.y) });
			pt.delete();
		}
		wasmPath.delete();
		result.push(path);
	}
	return result;
}

function wrapModule(M: any): ClipperEngine {
	return {
		name: 'clipper2-wasm',
		booleanOp(clipType, fillRule, subjects, clips) {
			const subjectPaths = toWasmPaths(subjects, M);
			const clipPaths = toWasmPaths(clips, M);
			const resultPaths = M.BooleanOp64(
				wrapEnumValue(clipType), wrapEnumValue(fillRule), subjectPaths, clipPaths);
			const result = fromWasmPaths(resultPaths);
			subjectPaths.delete();
			clipPaths.delete();
			resultPaths.delete();
			return result;
		},
		inflatePaths(paths, delta, joinType, endType, miterLimit = 2.0) {
			const wasmPaths = toWasmPaths(paths, M);
			const resultPaths = M.InflatePaths64(
				wasmPaths, delta, wrapEnumValue(joinType), wrapEnumValue(endType), miterLimit, 0);
			const result = fromWasmPaths(resultPaths);
			wasmPaths.delete();
			resultPaths.delete();
			return result;
		}
	};
}

let loadPromise: Promise<ClipperEngine | null> | null = null;

/**
 * Best-effort — never throws or rejects. Resolves null (the caller should
 * keep using the TS engine) if WebAssembly is unavailable or module init
 * fails for any reason: a strict CSP blocking wasm-unsafe-eval, an
 * unsupported/old runtime, a bad deploy that dropped the .wasm asset, etc.
 * Memoized: a fresh zone-fill worker calls this once at startup (see
 * zone-fill.worker.ts), and repeat calls within the same worker instance
 * (there shouldn't be any today, but this keeps it safe either way) just
 * reuse the same in-flight/resolved module instead of re-instantiating WASM.
 */
export function loadWasmClipperEngine(): Promise<ClipperEngine | null> {
	if (!loadPromise) {
		loadPromise = (async () => {
			if (typeof WebAssembly === 'undefined') {
				return null;
			}
			try {
				const M = await Clipper2ZFactory({ locateFile: () => clipper2zWasmUrl });
				return wrapModule(M);
			}
			catch (err) {
				console.warn(
					'[zone-fill] clipper2-wasm unavailable in this environment, falling back to the pure-TS Clipper2 engine:',
					err
				);
				return null;
			}
		})();
	}
	return loadPromise;
}
