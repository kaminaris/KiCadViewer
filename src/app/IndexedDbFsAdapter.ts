import {
	basenameGeneric, dirnameGeneric, extnameGeneric, isAbsoluteGeneric, joinPathGeneric, resolvePathGeneric
}                         from '@kicad-render/PathUtils';
import type { PathUtils } from '@kicad-io/Project/PathUtils';

interface FileRecord {
	key: string;
	projectId: string;
	path: string;
	text: string;
}

const DB_NAME = 'kionline-imported-files';
const DB_VERSION = 1;
const FILES_STORE = 'files';

/**
 * Implements kicad-io's loadFile/saveFile/PathUtils contract against
 * IndexedDB — the durable home for a project imported from a .zip (see
 * SessionController.openProjectZip). The zip itself is only ever read once,
 * at import time, to populate this store; every load after that (including
 * the very first one, and every subsequent browser tab) goes through here,
 * never back through ZipArchive/ZipFsAdapter. Unlike ZipFsAdapter this is
 * writable — saveFile persists an edit back into the same store, so an
 * imported project can be edited and saved like a folder project, just
 * without a real folder behind it.
 */
export class IndexedDbFsAdapter {
	protected dbPromise: Promise<IDBDatabase> | null = null;

	constructor(protected readonly projectId: string) {}

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
				if (!db.objectStoreNames.contains(FILES_STORE)) {
					db.createObjectStore(FILES_STORE, { keyPath: 'key' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open imported-project file store.'));
		});
		return this.dbPromise;
	}

	protected transactionDone(transaction: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error ?? new Error('Imported-project file transaction failed.'));
			transaction.onabort = () => reject(transaction.error ?? new Error('Imported-project file transaction aborted.'));
		});
	}

	protected keyFor(path: string): string {
		return `${ this.projectId }:${ path }`;
	}

	loadFile = async (filePath: string): Promise<string> => {
		const db = await this.openDb();
		return new Promise((resolve, reject) => {
			const request = db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE).get(this.keyFor(filePath));
			request.onsuccess = () => {
				const record = request.result as FileRecord | undefined;
				if (!record) {
					reject(new Error(`Not found: "${ filePath }"`));
					return;
				}
				resolve(record.text);
			};
			request.onerror = () => reject(request.error ?? new Error(`Could not read "${ filePath }".`));
		});
	};

	saveFile = async (filePath: string, content: string): Promise<void> => {
		const db = await this.openDb();
		const record: FileRecord = { key: this.keyFor(filePath), projectId: this.projectId, path: filePath, text: content };
		const transaction = db.transaction(FILES_STORE, 'readwrite');
		transaction.objectStore(FILES_STORE).put(record);
		await this.transactionDone(transaction);
	};
}
