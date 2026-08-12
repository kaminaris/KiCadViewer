import type { DocumentKind } from './ActiveDocument';

export interface PresenceInfo {
	peerId: string;
	view: DocumentKind;
	sheetPath: string | null;
}

export type SheetChangeOrigin = 'local' | 'remote';

/**
 * The interface editors depend on instead of touching persistence/transport
 * directly — see the harmonic-munching-trinket plan's Phase 5. `LocalProjectStore`
 * backs this with IndexedDB only (no transport). A later `SyncedProjectStore`
 * (Phase 6) adds the SharedWorker/BroadcastChannel transport underneath —
 * `onSheetChanged`/`onSelection`/`onPresenceChanged` exist here already
 * (as no-op-until-fired subscriptions for `LocalProjectStore`) precisely so
 * that swap needs zero call-site changes.
 */
export interface ProjectStore {
	/** No-op on LocalProjectStore (no transport to announce to); real on
	 *  SyncedProjectStore, which forwards to its ProjectSyncTransport. Kept
	 *  on the shared interface — not a SyncedProjectStore-only method — so
	 *  SessionController.ensureProjectStore doesn't need to know or care
	 *  which one it's holding. */
	connect(view: DocumentKind, sheetPath: string | null): void;

	/** Re-announces this peer's view/sheet without a full reconnect —
	 *  called when the local tab navigates within an already-open project
	 *  (switching sheets, or Schematic ↔ PCB). No-op on LocalProjectStore. */
	updatePresence(view: DocumentKind, sheetPath: string | null): void;

	loadSheet(sheetPath: string): Promise<string | null>;

	saveSheet(sheetPath: string, text: string): Promise<void>;

	onSheetChanged(handler: (sheetPath: string, text: string, origin: SheetChangeOrigin) => void): () => void;

	publishSelection(refs: string[]): void;

	onSelection(handler: (refs: string[]) => void): () => void;

	onPresenceChanged(handler: (peers: PresenceInfo[]) => void): () => void;

	/** Detaches all subscriptions — called whenever the owning page moves
	 *  on to a different project (see SessionController.ensureProjectStore). */
	dispose(): void;
}
