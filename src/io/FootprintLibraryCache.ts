import { KicadParser } from '@kicad-io/KicadParser';
import { KicadElementFootprint } from '@kicad-io/KicadElementFootprint';
import { KicadElementPad } from '@kicad-io/KicadElementPad';

export interface FootprintFileHandle {
	kind: 'file';
	name: string;
	getFile(): Promise<File>;
}

export interface FootprintDirectoryHandle {
	kind: 'directory';
	name: string;
	values(): AsyncIterable<FootprintFileHandle | FootprintDirectoryHandle>;
}

export interface CachedFootprintSummary {
	name: string;
	library: string;
	description: string;
	keywords: string;
	/** Total (pad ...) children — real KiCad's footprint-chooser "Filter by
	 *  pin count" checkbox compares this against the placing symbol's own
	 *  pin count (pcbnew/footprint_chooser_frame.cpp's filterByPinCount). */
	padCount: number;
	/** Mirrors GetFootprintDocumentationURL() (pcbnew/generate_footprint_info.cpp):
	 *  the footprint's own Datasheet property if set, else the first
	 *  http(s) URL found inside its description text, else empty. */
	documentationUrl: string;
}

export interface CachedFootprintFile {
	id: string;
	name: string;
	relativePath: string;
	size: number;
	lastModified: number;
	footprints: CachedFootprintSummary[];
	sourceText?: string;
	handle?: FootprintFileHandle;
}

export interface FootprintLibrarySummary {
	rootName: string;
	indexedAt: number;
	fileCount: number;
	footprintCount: number;
	errorCount: number;
}

export interface FootprintLibraryProgress {
	processedFiles: number;
	totalFiles?: number;
	fileName: string;
	footprintCount: number;
	error?: string;
}

type StoredSummary = FootprintLibrarySummary & { key: 'summary' };

const DB_NAME = 'kionline-footprint-library';
const DB_VERSION = 1;
const META_STORE = 'meta';
const FILE_STORE = 'files';

export class FootprintLibraryCache {
	protected dbPromise: Promise<IDBDatabase> | null = null;

	protected openDb(): Promise<IDBDatabase> {
		if (this.dbPromise) return this.dbPromise;
		if (typeof indexedDB === 'undefined') {
			return Promise.reject(new Error('IndexedDB is unavailable in this browser.'));
		}
		this.dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
				if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'id' });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open footprint cache.'));
		});
		return this.dbPromise;
	}

	protected transactionDone(transaction: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Footprint cache transaction failed.'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Footprint cache transaction aborted.'));
		});
	}

	protected async getAllFileRecords(): Promise<CachedFootprintFile[]> {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const request = db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).getAll();
			request.onsuccess = () => resolve((request.result as CachedFootprintFile[] | undefined) ?? []);
			request.onerror = () => reject(request.error ?? new Error('Could not read cached footprints.'));
		});
	}

	async clearAll(): Promise<void> {
		const db = await this.openDb();
		const transaction = db.transaction([FILE_STORE, META_STORE], 'readwrite');
		transaction.objectStore(FILE_STORE).clear();
		transaction.objectStore(META_STORE).delete('summary');
		await this.transactionDone(transaction);
	}

	protected async clearIndex(): Promise<void> {
		const db = await this.openDb();
		const transaction = db.transaction(FILE_STORE, 'readwrite');
		transaction.objectStore(FILE_STORE).clear();
		await this.transactionDone(transaction);
	}

	protected async recomputeSummary(rootName: string, errorCount: number): Promise<FootprintLibrarySummary> {
		const files = await this.getAllFileRecords();
		const summary: FootprintLibrarySummary = {
			rootName,
			indexedAt: Date.now(),
			fileCount: files.length,
			footprintCount: files.reduce((sum, file) => sum + file.footprints.length, 0),
			errorCount
		};
		await this.putSummary(summary);
		return summary;
	}

	/** Real KiCad's fallback URL extraction: the first http(s) URL embedded
	 *  in free-text (a datasheet field, or the description). Truncated the
	 *  same way GetFootprintDocumentationURL() does (72 chars + an ellipsis
	 *  past 75) — this is display-text cleanup, not a byte-exact port of its
	 *  paren-nesting-aware C++ scan. */
	protected extractDocumentationUrl(footprint: KicadElementFootprint, description: string): string {
		const datasheet = footprint.getProperties?.()
			.find(property => property.propertyName === 'Datasheet')?.propertyValue?.trim();
		const truncate = (url: string) => url.length > 75 ? `${ url.slice(0, 72) }…` : url;
		if (datasheet) {
			return truncate(datasheet);
		}
		const match = /https?:\S+/i.exec(description);
		return match ? truncate(match[0].replace(/[.,;)]+$/, '')) : '';
	}

	/** The library is the ".pretty" DIRECTORY a footprint file lives in, not
	 *  the file itself — unlike a symbol library, where one .kicad_sym file
	 *  IS the whole library. relativePath looks like
	 *  "Resistor_SMD.pretty/R_0805_2012Metric.kicad_mod", so the library
	 *  name is the segment ending in ".pretty", not the last segment. */
	protected libraryNameFromPath(relativePath: string): string {
		const segments = relativePath.split('/');
		const prettyIndex = segments.findIndex(segment => /\.pretty$/i.test(segment));
		if (prettyIndex >= 0) {
			return segments[prettyIndex]!.replace(/\.pretty$/i, '');
		}
		return segments.length > 1 ? segments[segments.length - 2]! : 'Library';
	}

	protected parseFootprints(text: string, relativePath: string): CachedFootprintSummary[] {
		const lib = this.libraryNameFromPath(relativePath);
		const parsed = new KicadParser().parse(text);
		// A standalone .kicad_mod file is a bare (footprint ...) s-expression
		// (no wrapping document) — same ambiguity KicadRenderSession.
		// getLibrarySymbolUnitCount already handles for standalone .kicad_sym
		// text, resolved the same way here.
		const footprint = parsed.name === 'footprint'
			? parsed as KicadElementFootprint
			: parsed.findFirstChildByClass(KicadElementFootprint);
		const rawName = footprint?.getFootprintName();
		if (!footprint || !rawName) {
			throw new Error('No footprint declaration found.');
		}
		const name = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
		const description = String(footprint.getSimpleChildValue('descr') ?? '').trim();
		const keywords = String(footprint.getSimpleChildValue('tags') ?? '').trim();
		const padCount = footprint.findChildrenByClass(KicadElementPad).length;
		const documentationUrl = this.extractDocumentationUrl(footprint, description);
		return [{ name, library: lib, description, keywords, padCount, documentationUrl }];
	}

	protected async putFile(file: CachedFootprintFile): Promise<void> {
		try {
			await this.putFileRecord(file);
		}
		catch (error) {
			if (!file.handle) throw error;
			await this.putFileRecord({ ...file, handle: undefined });
		}
	}

	protected async putFileRecord(file: CachedFootprintFile): Promise<void> {
		const db = await this.openDb();
		const transaction = db.transaction(FILE_STORE, 'readwrite');
		transaction.objectStore(FILE_STORE).put(file);
		await this.transactionDone(transaction);
	}

	protected async putSummary(summary: FootprintLibrarySummary): Promise<void> {
		const db = await this.openDb();
		const transaction = db.transaction(META_STORE, 'readwrite');
		transaction.objectStore(META_STORE).put({ ...summary, key: 'summary' } satisfies StoredSummary);
		await this.transactionDone(transaction);
	}

	protected async processFile(
		file: File,
		id: string,
		relativePath: string,
		handle: FootprintFileHandle | undefined
	): Promise<CachedFootprintFile> {
		const text = await file.text();
		return {
			id,
			name: file.name,
			relativePath,
			size: file.size,
			lastModified: file.lastModified,
			footprints: this.parseFootprints(text, relativePath),
			sourceText: text,
			handle
		};
	}

	protected async* walkDirectory(
		directory: FootprintDirectoryHandle,
		prefix = ''
	): AsyncGenerator<{ handle: FootprintFileHandle; relativePath: string }> {
		for await (const entry of directory.values()) {
			const relativePath = prefix ? `${ prefix }/${ entry.name }` : entry.name;
			if (entry.kind === 'directory') {
				yield* this.walkDirectory(entry, relativePath);
			}
			else if (entry.name.toLowerCase().endsWith('.kicad_mod')) {
				yield { handle: entry, relativePath };
			}
		}
	}

	async indexDirectory(
		directory: FootprintDirectoryHandle,
		onProgress?: (progress: FootprintLibraryProgress) => void
	): Promise<FootprintLibrarySummary> {
		await this.clearIndex();
		const entries: { handle: FootprintFileHandle; relativePath: string }[] = [];
		for await (const entry of this.walkDirectory(directory)) entries.push(entry);
		let processedFiles = 0;
		let errorCount = 0;
		for (const entry of entries) {
			processedFiles++;
			try {
				const file = await entry.handle.getFile();
				const record = await this.processFile(file, entry.relativePath, entry.relativePath, entry.handle);
				await this.putFile(record);
				onProgress?.({
					processedFiles,
					totalFiles: entries.length,
					fileName: entry.relativePath,
					footprintCount: record.footprints.length
				});
			}
			catch (error) {
				errorCount++;
				onProgress?.({
					processedFiles,
					totalFiles: entries.length,
					fileName: entry.relativePath,
					footprintCount: 0,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return this.recomputeSummary(directory.name, errorCount);
	}

	async indexFiles(
		files: FileList | File[],
		rootName: string,
		onProgress?: (progress: FootprintLibraryProgress) => void
	): Promise<FootprintLibrarySummary> {
		await this.clearIndex();
		const footprintFiles = Array.from(files).filter(file => {
			const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
			return relative.toLowerCase().endsWith('.kicad_mod');
		});
		let processedFiles = 0;
		let errorCount = 0;
		for (const file of footprintFiles) {
			processedFiles++;
			const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
			try {
				const record = await this.processFile(file, relativePath, relativePath, undefined);
				await this.putFile(record);
				onProgress?.({
					processedFiles,
					totalFiles: footprintFiles.length,
					fileName: relativePath,
					footprintCount: record.footprints.length
				});
			}
			catch (error) {
				errorCount++;
				onProgress?.({
					processedFiles,
					totalFiles: footprintFiles.length,
					fileName: relativePath,
					footprintCount: 0,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return this.recomputeSummary(rootName, errorCount);
	}

	async getSummary(): Promise<FootprintLibrarySummary | null> {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const request = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get('summary');
			request.onsuccess = () => resolve((request.result as StoredSummary | undefined) ?? null);
			request.onerror = () => reject(request.error ?? new Error('Could not read footprint cache.'));
		});
	}

	/** Mirrors SymbolLibraryCache.getFiles(): never brings every library
	 *  file's persisted source text into memory just to populate the
	 *  chooser list — that's loaded on demand via readCachedFile(). */
	async getFiles(): Promise<CachedFootprintFile[]> {
		const records = await this.getAllFileRecords();
		return records.map(({ sourceText: _sourceText, ...metadata }) => metadata);
	}

	async readCachedFile(id: string): Promise<string> {
		const db = await this.openDb();
		const file = await new Promise<CachedFootprintFile | undefined>((resolve, reject) => {
			const request = db.transaction(FILE_STORE, 'readonly').objectStore(FILE_STORE).get(id);
			request.onsuccess = () => resolve(request.result as CachedFootprintFile | undefined);
			request.onerror = () => reject(request.error ?? new Error('Could not read cached footprint file.'));
		});
		if (!file) {
			throw new Error('Cached footprint file was not found. Re-index the footprint directory.');
		}
		if (file.sourceText) {
			return file.sourceText;
		}
		if (file.handle) {
			const diskFile = await file.handle.getFile();
			return diskFile.text();
		}
		throw new Error('Cached footprint file has no source text or handle available.');
	}
}
