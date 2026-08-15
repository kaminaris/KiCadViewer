import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';
import { KicadParser }        from '@kicad-io/KicadParser';

/**
 * Minimal structural types keep this service usable in browsers whose DOM
 * typings do not yet expose the File System Access API. Chromium's native
 * FileSystemFileHandle/FileSystemDirectoryHandle objects satisfy these
 * interfaces at runtime and can be stored in IndexedDB via structured clone.
 */
export interface SymbolFileHandle {
	kind: 'file';
	name: string;

	getFile(): Promise<File>;
}

export interface SymbolDirectoryHandle {
	kind: 'directory';
	name: string;

	values(): AsyncIterable<SymbolFileHandle | SymbolDirectoryHandle>;
}

export interface CachedSymbolSummary {
	name: string;
	reference: string;
	value: string;
	description: string;
	keywords: string;
	units: number;
}

export interface CachedSymbolFile {
	id: string;
	name: string;
	relativePath: string;
	size: number;
	lastModified: number;
	symbols: CachedSymbolSummary[];
	/** Raw source is persisted only for file-input fallback placement. It is
	 * kept in IndexedDB, not held in the in-memory index. */
	sourceText?: string;
	/** Available when the browser supports persistent file handles. */
	handle?: SymbolFileHandle;
	/** True only for the app's own bundled fallback libraries (see
	 * ensureDefaultLibrary) — protected from indexDirectory()/indexFiles()'s
	 * reindex-clear so pointing the chooser at a personal folder doesn't wipe
	 * out the one library (Device) every project can otherwise rely on. */
	builtIn?: boolean;
}

export interface SymbolLibrarySummary {
	rootName: string;
	indexedAt: number;
	fileCount: number;
	symbolCount: number;
	errorCount: number;
}

export interface SymbolLibraryProgress {
	processedFiles: number;
	totalFiles?: number;
	fileName: string;
	symbolCount: number;
	error?: string;
}

type StoredSummary = SymbolLibrarySummary & { key: 'summary' };

const DB_NAME = 'kionline-symbol-library';
const DB_VERSION = 1;
const META_STORE = 'meta';
const FILE_STORE = 'files';

/**
 * Persistent index for a user-selected KiCad symbols directory.
 *
 * File contents are read and parsed one file at a time. The chooser keeps only
 * extracted metadata in memory; source text is persisted in IndexedDB solely
 * so the ordinary `<input webkitdirectory>` fallback can place a symbol later.
 */
export class SymbolLibraryCache {
	protected dbPromise: Promise<IDBDatabase> | null = null;

	protected openDb(): Promise<IDBDatabase> {
		if (this.dbPromise) {
			return this.dbPromise;
		}
		if (typeof indexedDB === 'undefined') {
			return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
		}
		this.dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(META_STORE)) {
					db.createObjectStore(META_STORE, { keyPath: 'key' });
				}
				if (!db.objectStoreNames.contains(FILE_STORE)) {
					db.createObjectStore(FILE_STORE, { keyPath: 'id' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open symbol cache.'));
		});
		return this.dbPromise;
	}

	protected transactionDone(transaction: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Symbol cache transaction failed.'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Symbol cache transaction aborted.'));
		});
	}

	protected async getAllFileRecords(): Promise<CachedSymbolFile[]> {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const request = db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).getAll();
			request.onsuccess = () => resolve((request.result as CachedSymbolFile[] | undefined) ?? []);
			request.onerror = () => reject(request.error ?? new Error('Could not read cached symbols.'));
		});
	}

	/** Drops every indexed file EXCEPT builtIn ones — indexDirectory()/
	 * indexFiles()'s "start fresh" step, scoped to leave the app's own
	 * bundled libraries (see ensureDefaultLibrary) untouched. A stale
	 * user-indexed file that no longer exists on disk is expected to
	 * disappear on the next reindex; a builtIn one has no "disk" to go
	 * stale against, so it's exempt. */
	protected async clearUserIndex(): Promise<void> {
		const files = await this.getAllFileRecords();
		const db = await this.openDb();
		const transaction = db.transaction(FILE_STORE, 'readwrite');
		const store = transaction.objectStore(FILE_STORE);
		for (const file of files) {
			if (!file.builtIn) {
				store.delete(file.id);
			}
		}
		await this.transactionDone(transaction);
	}

	/** Recomputes and stores the summary from whatever's actually in the
	 * file store right now (builtIn + user-indexed together) — the count the
	 * chooser's title bar shows should always reflect the true total, not
	 * just whatever the most recent indexDirectory()/indexFiles() call
	 * touched. */
	protected async recomputeSummary(rootName: string, errorCount: number): Promise<SymbolLibrarySummary> {
		const files = await this.getAllFileRecords();
		const summary: SymbolLibrarySummary = {
			rootName,
			indexedAt: Date.now(),
			fileCount: files.length,
			symbolCount: files.reduce((sum, file) => sum + file.symbols.length, 0),
			errorCount
		};
		await this.putSummary(summary);
		return summary;
	}

	/** `handle` (a live FileSystemFileHandle, from the indexDirectory path)
	 *  has occasionally been observed to throw `DataCloneError` from the
	 *  underlying `.put()` call — confirmed live: the throw is synchronous
	 *  (inside `putFileRecord`, before `transactionDone`'s promise even
	 *  resolves), which the caller's `symbolCount +=` already ran before,
	 *  so the file silently never reaches IndexedDB at all while the
	 *  progress/summary reports it as indexed. `sourceText` is always a
	 *  plain string (guaranteed cloneable) and is exactly the documented
	 *  fallback for "no usable handle" already — reusing it here too rather
	 *  than losing the entry outright. */
	protected async putFile(file: CachedSymbolFile): Promise<void> {
		try {
			await this.putFileRecord(file);
		}
		catch (error) {
			if (!file.handle) {
				throw error;
			}
			await this.putFileRecord({ ...file, handle: undefined });
		}
	}

	protected async putFileRecord(file: CachedSymbolFile): Promise<void> {
		const db = await this.openDb();
		const transaction = db.transaction(FILE_STORE, 'readwrite');
		transaction.objectStore(FILE_STORE).put(file);
		await this.transactionDone(transaction);
	}

	protected async putSummary(summary: SymbolLibrarySummary): Promise<void> {
		const db = await this.openDb();
		const transaction = db.transaction(META_STORE, 'readwrite');
		transaction.objectStore(META_STORE).put({ ...summary, key: 'summary' } satisfies StoredSummary);
		await this.transactionDone(transaction);
	}

	protected async extractSymbols(text: string): Promise<CachedSymbolSummary[]> {
		const root = new KicadParser().parse(text);
		if (!root) {
			throw new Error('Parser returned no root element.');
		}
		// Standalone `.kicad_sym` files contain direct `symbol` children under
		// `kicad_symbol_lib`; the embedded schematic form uses `lib_symbols`.
		// In both cases direct children are the library entries. Avoid recursive
		// traversal because multi-unit symbols contain nested symbol children.
		const symbols = root.children.filter(child => child instanceof KicadElementSymbol) as KicadElementSymbol[];
		const byName = new Map(symbols.filter(s => s.symbolName).map(s => [s.symbolName!, s]));
		return symbols
			.filter(symbol => !!symbol.symbolName)
			.map(symbol => {
				// A derived symbol (`(extends "Base")`) typically has few or no
				// properties of its own — real KiCad falls back to the base's
				// Reference/Value/Description/etc. everywhere (LIB_SYMBOL::
				// IsDerived() gates throughout lib_symbol.cpp). Resolve one
				// level (real-world libraries don't chain extends further)
				// and use the base ONLY for whatever the derived symbol
				// doesn't define itself, same as real KiCad's own fallback —
				// an explicit override on the derived symbol always wins.
				const base = symbol.isDerived() ? byName.get(symbol.getExtends()!) : undefined;
				const properties = symbol.getAllProperties();
				const baseProperties = base?.getAllProperties() ?? {};
				return {
					name: symbol.symbolName!,
					reference: properties.Reference ?? symbol.getReference?.() ?? baseProperties.Reference
						?? base?.getReference?.() ?? '',
					value: properties.Value ?? baseProperties.Value ?? '',
					description: properties.Description ?? properties.ki_description ?? baseProperties.Description
						?? baseProperties.ki_description ?? '',
					keywords: properties.ki_keywords ?? baseProperties.ki_keywords ?? '',
					units: Math.max(1, symbol.getUnitId?.() || (base ?? symbol).getUnitId?.() || 1)
				};
			});
	}

	protected async processFile(
		file: File,
		id: string,
		name: string,
		relativePath: string,
		handle: SymbolFileHandle | undefined
	): Promise<CachedSymbolFile> {
		// Keep this scope deliberately small: once metadata has been extracted,
		// neither the File nor its text is retained by the cache object.
		const text = await file.text();
		const symbols = await this.extractSymbols(text);
		return {
			id,
			name,
			relativePath,
			size: file.size,
			lastModified: file.lastModified,
			symbols,
			sourceText: text,
			handle
		};
	}

	protected async* walkDirectory(
		directory: SymbolDirectoryHandle,
		prefix = ''
	): AsyncGenerator<{ handle: SymbolFileHandle; relativePath: string }> {
		for await (const entry of directory.values()) {
			const relativePath = prefix ? `${ prefix }/${ entry.name }` : entry.name;
			if (entry.kind === 'directory') {
				yield* this.walkDirectory(entry, relativePath);
			}
			else if (entry.name.toLowerCase().endsWith('.kicad_sym')) {
				yield { handle: entry, relativePath };
			}
		}
	}

	async indexDirectory(
		directory: SymbolDirectoryHandle,
		onProgress?: (progress: SymbolLibraryProgress) => void
	): Promise<SymbolLibrarySummary> {
		await this.clearUserIndex();
		// Enumerate the whole tree up front — just directory listings, no file
		// reads yet — so onProgress can report a real total instead of only a
		// running count (a progress modal with an unknown denominator can't
		// show a meaningful percentage/bar fill).
		const entries: { handle: SymbolFileHandle; relativePath: string }[] = [];
		for await (const entry of this.walkDirectory(directory)) {
			entries.push(entry);
		}
		let processedFiles = 0;
		let errorCount = 0;

		for (const entry of entries) {
			processedFiles++;
			try {
				const file = await entry.handle.getFile();
				const record = await this.processFile(
					file, entry.relativePath, entry.handle.name, entry.relativePath, entry.handle);
				await this.putFile(record);
				onProgress?.({
					processedFiles, totalFiles: entries.length, fileName: entry.relativePath, symbolCount: record.symbols.length
				});
			}
			catch (error) {
				errorCount++;
				onProgress?.({
					processedFiles,
					totalFiles: entries.length,
					fileName: entry.relativePath,
					symbolCount: 0,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}

		return this.recomputeSummary(directory.name, errorCount);
	}

	/** Fallback for browsers without showDirectoryPicker(). File handles are
	 * unavailable in this path, but the same metadata cache is still useful. */
	async indexFiles(
		files: FileList | File[],
		rootName: string,
		onProgress?: (progress: SymbolLibraryProgress) => void
	): Promise<SymbolLibrarySummary> {
		await this.clearUserIndex();
		const symbolFiles = Array.from(files).filter(file => {
			// Chromium always defines `webkitRelativePath` as `""` (never
			// `undefined`) on files that weren't picked via a `webkitdirectory`
			// input, so `?? file.name` never actually falls through — `||` is
			// required to treat the empty string itself as "absent".
			const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
			return relative.toLowerCase().endsWith('.kicad_sym');
		});
		let processedFiles = 0;
		let errorCount = 0;
		for (const file of symbolFiles) {
			processedFiles++;
			const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
			try {
				const record = await this.processFile(file, relativePath, file.name, relativePath, undefined);
				await this.putFile(record);
				onProgress?.({
					processedFiles,
					totalFiles: symbolFiles.length,
					fileName: relativePath,
					symbolCount: record.symbols.length
				});
			}
			catch (error) {
				errorCount++;
				onProgress?.({
					processedFiles,
					totalFiles: symbolFiles.length,
					fileName: relativePath,
					symbolCount: 0,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return this.recomputeSummary(rootName, errorCount);
	}

	/**
	 * Real KiCad ships a "Device" library (generic passives — R, C, L, D, ...)
	 * bundled with every install, always present as the first/default place
	 * to look when placing a symbol. This app has no filesystem to bundle a
	 * library into, so `public/libraries/Device.kicad_sym` (a real, unmodified
	 * copy — see shared/kicad-io/test/fixtures/kicad-qa/libraries/Device.
	 * kicad_sym) stands in for it, fetched and indexed once, flagged
	 * `builtIn: true` so indexDirectory()/indexFiles()'s clearUserIndex()
	 * never removes it — pointing the chooser at a personal folder is meant
	 * to ADD libraries (matching real KiCad's persistent, multi-library
	 * sym-lib-table), not replace the one library every project can rely on.
	 */
	async ensureDefaultLibrary(): Promise<void> {
		const files = await this.getAllFileRecords();
		if (files.some(file => file.id === 'Device.kicad_sym')) {
			return;
		}
		try {
			const response = await fetch('/libraries/Device.kicad_sym');
			if (!response.ok) {
				return;
			}
			const text = await response.text();
			const symbols = await this.extractSymbols(text);
			await this.putFile({
				id: 'Device.kicad_sym', name: 'Device.kicad_sym', relativePath: 'Device.kicad_sym',
				size: text.length, lastModified: Date.now(), symbols, sourceText: text, builtIn: true
			});
			await this.recomputeSummary((await this.getSummary())?.rootName ?? 'Device (built-in)', 0);
		}
		catch {
			// Best-effort — a fetch/parse failure here just leaves the chooser
			// empty until the user indexes their own library, same as before
			// this method existed.
		}
	}

	async getSummary(): Promise<SymbolLibrarySummary | null> {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const transaction = db.transaction(META_STORE, 'readonly');
			const request = transaction.objectStore(META_STORE).get('summary');
			request.onsuccess = () => resolve((request.result as StoredSummary | undefined) ?? null);
			request.onerror = () => reject(request.error ?? new Error('Could not read symbol cache.'));
		});
	}

	async getFiles(): Promise<CachedSymbolFile[]> {
		const records = await this.getAllFileRecords();
		// Never bring the persisted source text for every library file into
		// memory just to populate the chooser; it is loaded on demand below.
		return records.map(({ sourceText: _sourceText, ...metadata }) => metadata);
	}

	/** Future symbol-placement code can opt into loading one cached library
	 * file on demand. Indexing itself never calls this method. */
	async readCachedFile(id: string): Promise<string> {
		const db = await this.openDb();
		const file = await new Promise<CachedSymbolFile | undefined>((resolve, reject) => {
			const request = db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).get(id);
			request.onsuccess = () => resolve(request.result as CachedSymbolFile | undefined);
			request.onerror = () => reject(request.error ?? new Error('Could not read cached symbol file.'));
		});
		if (!file) {
			throw new Error('Cached symbol file was not found. Re-index the symbol directory.');
		}
		// processFile() always populates sourceText at index time regardless of
		// whether a handle is also available, so it is always the cheaper and
		// more reliable read: no extra disk I/O, no dependency on the handle's
		// permission grant still being valid. Prefer it; a live handle is only
		// useful as a fallback for older cached records from before sourceText
		// was captured unconditionally.
		if (file.sourceText) {
			return file.sourceText;
		}
		if (file.handle) {
			return (await file.handle.getFile()).text();
		}
		throw new Error('This cached entry has no readable source. Re-index the symbol directory.');
	}
}
