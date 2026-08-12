import {
	basenameGeneric, dirnameGeneric, extnameGeneric, isAbsoluteGeneric, joinPathGeneric, resolvePathGeneric
}                         from '@kicad-render/PathUtils';
import type { PathUtils } from '@kicad-io/Project/PathUtils';

/**
 * Minimal structural types for the File System Access API — same reasoning
 * as SymbolLibraryCache.ts's SymbolFileHandle/SymbolDirectoryHandle: this
 * project's DOM lib doesn't expose the real types, and Chromium's native
 * handle objects satisfy these interfaces at runtime regardless. Extended
 * beyond that file's read-only shape with getFileHandle/getDirectoryHandle
 * (traversal + creation) and createWritable (actual writes), since this
 * adapter needs both directions.
 */
export interface FsWritableStream {
	write(data: string): Promise<void>;

	close(): Promise<void>;
}

export interface FsFileHandle {
	kind: 'file';
	name: string;

	getFile(): Promise<File>;

	createWritable(): Promise<FsWritableStream>;
}

export interface FsDirectoryHandle {
	kind: 'directory';
	name: string;

	getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;

	getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectoryHandle>;

	entries(): AsyncIterable<[string, FsFileHandle | FsDirectoryHandle]>;

	requestPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;

	queryPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}

/** `undefined` on browsers without the API (Firefox/Safari as of this
 *  writing) — callers feature-detect via this rather than assuming. */
export function getDirectoryPicker():
	((options?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>) | undefined {
	return (window as Window & {
		showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>;
	}).showDirectoryPicker;
}

/**
 * Implements kicad-io's `loadFile`/`saveFile`/`PathUtils` DI contract
 * against a picked `FsDirectoryHandle` — the browser-native counterpart to
 * `api/src/Modules/Bom/Service/KiCad.Service.ts`'s gateway-backed adapter,
 * same seam, different concrete storage.
 *
 * Paths are relative to `root` with NO leading segment for root — a file
 * directly in the picked folder is just its bare filename (e.g.
 * "MyProject.kicad_sch"), not "MyProject/MyProject.kicad_sch". This keeps
 * kicad-io's own dirname/join logic (KicadSchematic.loadFromPath resolving
 * a sub-sheet's relative Sheetfile against `this.dirname`) working
 * unmodified: the root schematic's own dirname is '' (no separator in a
 * bare filename), so `join('', 'Sub.kicad_sch')` correctly yields
 * "Sub.kicad_sch" with no root-name prefix ever appearing.
 *
 * Known, accepted limitation: a sheet reference that walks ABOVE the picked
 * root (e.g. "../SharedLib/Common.kicad_sch") cannot be resolved — the File
 * System Access API's directory handles have no ".." traversal, and there
 * is no real OS path underneath to fall back to. This is an inherent
 * browser-sandbox limitation, not a bug in path resolution here.
 */
export class BrowserFsAdapter {
	constructor(public readonly root: FsDirectoryHandle) {}

	readonly pathUtils: PathUtils = {
		dirname: dirnameGeneric,
		resolve: (...paths: string[]) => resolvePathGeneric(...paths),
		join: (...paths: string[]) => paths.reduce((acc, p) => (acc ? joinPathGeneric(acc, p) : p), ''),
		basename: (filePath: string, ext?: string) => {
			const base = basenameGeneric(filePath);
			return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
		},
		extname: extnameGeneric,
		isAbsolute: isAbsoluteGeneric
	};

	loadFile = async (filePath: string): Promise<string> => {
		const handle = await this.resolveFileHandle(filePath, false);
		const file = await handle.getFile();
		return file.text();
	};

	saveFile = async (filePath: string, content: string): Promise<void> => {
		const handle = await this.resolveFileHandle(filePath, true);
		const writable = await handle.createWritable();
		await writable.write(content);
		await writable.close();
	};

	/** Lists entry names directly inside `dirPath` (bare names, not full
	 *  paths) — `''` lists the picked root itself. Used to find the
	 *  `.kicad_pro` when a user picks a bare project folder, per
	 *  KicadProject.openFromProjectRoot's own note that this resolution
	 *  belongs at the adapter layer. */
	listDir = async (dirPath: string): Promise<string[]> => {
		const dir = dirPath ? await this.resolveDirectoryHandle(dirPath, false) : this.root;
		const names: string[] = [];
		for await (const [name] of dir.entries()) {
			names.push(name);
		}
		return names;
	};

	/** Finds the single `.kicad_pro` directly inside the picked root, if
	 *  any — the common "user picked a project folder" case B2 needs. */
	async findProjectFile(): Promise<string | null> {
		const names = await this.listDir('');
		return names.find(name => name.toLowerCase().endsWith('.kicad_pro')) ?? null;
	}

	protected segmentsOf(filePath: string): string[] {
		return filePath.split(/[\\/]+/).filter(Boolean);
	}

	protected async resolveDirectoryHandle(dirPath: string, create: boolean): Promise<FsDirectoryHandle> {
		let current = this.root;
		for (const segment of this.segmentsOf(dirPath)) {
			current = await current.getDirectoryHandle(segment, { create });
		}
		return current;
	}

	protected async resolveFileHandle(filePath: string, create: boolean): Promise<FsFileHandle> {
		const segments = this.segmentsOf(filePath);
		const fileName = segments.pop();
		if (!fileName) {
			throw new Error(`Invalid file path: "${ filePath }"`);
		}
		const dir = segments.length ? await this.resolveDirectoryHandle(segments.join('/'), create) : this.root;
		return dir.getFileHandle(fileName, { create });
	}
}
