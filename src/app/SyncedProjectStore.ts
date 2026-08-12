import type { ProjectStore, PresenceInfo, SheetChangeOrigin } from './ProjectStore';
import { LocalProjectStore }                                   from './LocalProjectStore';
import type { ProjectSyncTransport }                           from './transport/ProjectSyncTransport';
import type { DocumentKind }                                   from './ActiveDocument';

/**
 * LocalProjectStore + a ProjectSyncTransport. IndexedDB stays the durable
 * source of truth (a tab that opens after an edit sees it there regardless
 * of whether any peer tab is still open) — the transport is purely a live
 * "hey, this just changed" signal layered on top, so a tab that already has
 * the project open doesn't need to wait for a reload to see someone else's
 * edit. See the harmonic-munching-trinket plan's Phase 6 — this is the only
 * thing that changed from Phase 5's LocalProjectStore; every call site that
 * already used ProjectStore keeps working unmodified.
 */
export class SyncedProjectStore implements ProjectStore {
	protected readonly local: LocalProjectStore;
	protected readonly unsubscribeTransport: () => void;
	protected readonly selectionHandlers = new Set<(refs: string[]) => void>();
	protected readonly presenceHandlers = new Set<(peers: PresenceInfo[]) => void>();

	constructor(projectId: string, protected readonly transport: ProjectSyncTransport) {
		this.local = new LocalProjectStore(projectId);
		this.unsubscribeTransport = this.transport.onMessage((payload, fromPeerId) => {
			if (fromPeerId === this.transport.peerId) {
				return;
			}
			if (payload.kind === 'model-changed') {
				void this.local.applyRemoteSheet(payload.sheetPath, payload.text);
			}
			else if (payload.kind === 'selection') {
				for (const handler of this.selectionHandlers) {
					handler(payload.refs);
				}
			}
			else {
				for (const handler of this.presenceHandlers) {
					handler(payload.peers);
				}
			}
		});
	}

	connect(view: DocumentKind, sheetPath: string | null): void {
		this.transport.connect(view, sheetPath);
	}

	updatePresence(view: DocumentKind, sheetPath: string | null): void {
		this.transport.updatePresence(view, sheetPath);
	}

	loadSheet(sheetPath: string): Promise<string | null> {
		return this.local.loadSheet(sheetPath);
	}

	async saveSheet(sheetPath: string, text: string): Promise<void> {
		await this.local.saveSheet(sheetPath, text);
		this.transport.publish({ kind: 'model-changed', sheetPath, text });
	}

	onSheetChanged(handler: (sheetPath: string, text: string, origin: SheetChangeOrigin) => void): () => void {
		return this.local.onSheetChanged(handler);
	}

	publishSelection(refs: string[]): void {
		this.transport.publish({ kind: 'selection', refs });
	}

	onSelection(handler: (refs: string[]) => void): () => void {
		this.selectionHandlers.add(handler);
		return () => this.selectionHandlers.delete(handler);
	}

	onPresenceChanged(handler: (peers: PresenceInfo[]) => void): () => void {
		this.presenceHandlers.add(handler);
		return () => this.presenceHandlers.delete(handler);
	}

	dispose(): void {
		this.unsubscribeTransport();
		this.transport.disconnect();
		this.local.dispose();
		this.selectionHandlers.clear();
		this.presenceHandlers.clear();
	}
}
