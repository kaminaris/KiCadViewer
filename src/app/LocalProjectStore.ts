import type { ProjectStore, PresenceInfo, SheetChangeOrigin } from './ProjectStore';
import type { DocumentKind }                                   from './ActiveDocument';

interface SheetRecord {
	key: string;
	projectId: string;
	sheetPath: string;
	text: string;
	updatedAt: number;
}

const DB_NAME = 'kionline-project-state';
const DB_VERSION = 1;
const SHEETS_STORE = 'sheets';

/**
 * IndexedDB-only `ProjectStore` — one instance per open project (see
 * SessionController.ensureProjectStore). Keyed `projectId:sheetPath` so the
 * same store can hold every sheet of a hierarchical schematic (and, later,
 * the board) without collisions. `onSelection`/`onPresenceChanged` have no
 * transport to drive them yet (see the harmonic-munching-trinket plan's
 * Phase 6) — kept as real subscriptions that simply never fire until then,
 * rather than throwing, so call sites don't need to special-case "no
 * transport yet".
 */
export class LocalProjectStore implements ProjectStore {
	protected dbPromise: Promise<IDBDatabase> | null = null;
	protected readonly sheetChangedHandlers = new Set<(sheetPath: string, text: string, origin: SheetChangeOrigin) => void>();
	protected readonly selectionHandlers = new Set<(refs: string[]) => void>();
	protected readonly presenceHandlers = new Set<(peers: PresenceInfo[]) => void>();

	constructor(protected readonly projectId: string) {}

	/** No transport exists at this layer (Phase 6's SyncedProjectStore is
	 *  what actually connects) — nothing to announce presence to. */
	connect(_view: DocumentKind, _sheetPath: string | null): void {}

	updatePresence(_view: DocumentKind, _sheetPath: string | null): void {}

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
				if (!db.objectStoreNames.contains(SHEETS_STORE)) {
					db.createObjectStore(SHEETS_STORE, { keyPath: 'key' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open project state store.'));
		});
		return this.dbPromise;
	}

	protected transactionDone(transaction: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Project state transaction failed.'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Project state transaction aborted.'));
		});
	}

	protected keyFor(sheetPath: string): string {
		return `${ this.projectId }:${ sheetPath }`;
	}

	async loadSheet(sheetPath: string): Promise<string | null> {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const request = db.transaction(SHEETS_STORE, 'readonly').objectStore(SHEETS_STORE).get(this.keyFor(sheetPath));
			request.onsuccess = () => resolve((request.result as SheetRecord | undefined)?.text ?? null);
			request.onerror = () => reject(request.error ?? new Error('Could not load sheet.'));
		});
	}

	async saveSheet(sheetPath: string, text: string): Promise<void> {
		await this.writeSheet(sheetPath, text);
		this.notifySheetChanged(sheetPath, text, 'local');
	}

	/** Applies an update that arrived from another tab (see
	 *  SyncedProjectStore) — writes through to IndexedDB exactly like
	 *  saveSheet, but notifies listeners with origin:'remote' so
	 *  SessionController's live-reload hook can tell this apart from the
	 *  local tab's own edit (which would otherwise look like something
	 *  that needs to be re-published right back out). Not part of the
	 *  ProjectStore interface — only SyncedProjectStore, which holds this
	 *  concrete class rather than just the interface, calls it. */
	async applyRemoteSheet(sheetPath: string, text: string): Promise<void> {
		await this.writeSheet(sheetPath, text);
		this.notifySheetChanged(sheetPath, text, 'remote');
	}

	protected async writeSheet(sheetPath: string, text: string): Promise<void> {
		const db = await this.openDb();
		const record: SheetRecord = { key: this.keyFor(sheetPath), projectId: this.projectId, sheetPath, text, updatedAt: Date.now() };
		const transaction = db.transaction(SHEETS_STORE, 'readwrite');
		transaction.objectStore(SHEETS_STORE).put(record);
		await this.transactionDone(transaction);
	}

	protected notifySheetChanged(sheetPath: string, text: string, origin: SheetChangeOrigin): void {
		for (const handler of this.sheetChangedHandlers) {
			handler(sheetPath, text, origin);
		}
	}

	onSheetChanged(handler: (sheetPath: string, text: string, origin: SheetChangeOrigin) => void): () => void {
		this.sheetChangedHandlers.add(handler);
		return () => this.sheetChangedHandlers.delete(handler);
	}

	/** No transport exists yet (Phase 6) — nothing to publish to. */
	publishSelection(_refs: string[]): void {}

	onSelection(handler: (refs: string[]) => void): () => void {
		this.selectionHandlers.add(handler);
		return () => this.selectionHandlers.delete(handler);
	}

	onPresenceChanged(handler: (peers: PresenceInfo[]) => void): () => void {
		this.presenceHandlers.add(handler);
		return () => this.presenceHandlers.delete(handler);
	}

	dispose(): void {
		this.sheetChangedHandlers.clear();
		this.selectionHandlers.clear();
		this.presenceHandlers.clear();
	}
}
