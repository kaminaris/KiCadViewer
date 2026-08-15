// clipper2-wasm ships hand-written .d.ts files at dist/clipper2z.d.ts, but
// none at the actual dist/es/clipper2z.js path this app imports (its own
// package.json "types" field points at a path that doesn't exist in the
// published package) — this is the minimal ambient shape wasmClipperEngine.ts
// actually uses, not a full re-declaration of the module's real API.
declare module 'clipper2-wasm/dist/es/clipper2z.js' {
	const factory: (options?: { locateFile?: (path: string) => string }) => Promise<any>;
	export default factory;
}
