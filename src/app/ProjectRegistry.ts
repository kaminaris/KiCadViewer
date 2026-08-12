import type { FsDirectoryHandle } from './BrowserFsAdapter';

export type ProjectRecordKind = 'folder' | 'imported';

export interface ProjectRecord {
	/** Stable id — reuses the exact `key` scheme SessionController already
	 *  computes for ProjectContext (`folder:<dirName>:<proFile>` /
	 *  `imported:<filename>:<size>`), so this registry and the cross-tab
	 *  sync layer (see harmonic-munching-trinket plan) recognize "the same
	 *  project" identically. */
	id: string;
	name: string;
	kind: ProjectRecordKind;
	/** Only present for folder-backed projects — the picked root directory
	 *  handle, structured-clone-stored so a later tab or a fresh page load
	 *  can re-request permission and reopen without the user re-picking the
	 *  folder (see BrowserFsAdapter's own FsDirectoryHandle doc comment for
	 *  the same structured-clone assumption). 'imported' projects need no
	 *  equivalent — their files already live in IndexedDB (see
	 *  IndexedDbFsAdapter), so any tab reopens instantly with no permission
	 *  prompt at all. */
	dirHandle?: FsDirectoryHandle;
	/** Bare filename of the .kicad_pro — for 'folder' it's directly inside
	 *  dirHandle; for 'imported' it's the path IndexedDbFsAdapter extracted
	 *  it under. Either way, avoids re-deriving it on reopen. */
	proFile?: string;
	lastOpenedAt: number;
	sheetCount?: number;
}

const DB_NAME = 'kionline-projects';
const DB_VERSION = 1;
const PROJECTS_STORE = 'projects';

/** Persistent, cross-tab-visible list of every project this browser has
 *  opened — what the Home screen lists, and (via `dirHandle`) how a second
 *  browser tab or a later session reopens the same folder-backed project
 *  without a fresh directory picker. Modeled directly on
 *  SymbolLibraryCache.ts's IndexedDB patterns (same openDb/
 *  transactionDone shape, same defensive retry for a live handle that
 *  fails structured-clone). */
export class ProjectRegistry {
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
				if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
					db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open project registry.'));
		});
		return this.dbPromise;
	}

	protected transactionDone(transaction: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Project registry transaction failed.'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Project registry transaction aborted.'));
		});
	}

	/** See SymbolLibraryCache.putFile's identical doc comment — a live
	 *  FsDirectoryHandle has occasionally been observed to throw
	 *  DataCloneError from the underlying put() call. Retrying once without
	 *  the handle keeps the project listed (just not silently re-openable
	 *  without a fresh folder pick) instead of losing the entry outright. */
	async upsertProject(record: ProjectRecord): Promise<void> {
		try {
			await this.putRecord(record);
		}
		catch (error) {
			if (!record.dirHandle) {
				throw error;
			}
			await this.putRecord({ ...record, dirHandle: undefined });
		}
	}

	protected async putRecord(record: ProjectRecord): Promise<void> {
		const db = await this.openDb();
		const transaction = db.transaction(PROJECTS_STORE, 'readwrite');
		transaction.objectStore(PROJECTS_STORE).put(record);
		await this.transactionDone(transaction);
	}

	async getProject(id: string): Promise<ProjectRecord | undefined> {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const request = db.transaction(PROJECTS_STORE, 'readonly').objectStore(PROJECTS_STORE).get(id);
			request.onsuccess = () => resolve(request.result as ProjectRecord | undefined);
			request.onerror = () => reject(request.error ?? new Error('Could not read project.'));
		});
	}

	/** Newest-opened first — matches how a Home screen / recent-projects
	 *  list is naturally consumed. */
	async listProjects(): Promise<ProjectRecord[]> {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const request = db.transaction(PROJECTS_STORE, 'readonly').objectStore(PROJECTS_STORE).getAll();
			request.onsuccess = () => {
				const records = (request.result as ProjectRecord[] | undefined) ?? [];
				resolve(records.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
			};
			request.onerror = () => reject(request.error ?? new Error('Could not list projects.'));
		});
	}
}
