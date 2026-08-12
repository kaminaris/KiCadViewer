import type { DocumentKind } from '../ActiveDocument';
import type { PresenceInfo } from '../ProjectStore';

/** What actually crosses the wire — SharedWorker postMessage or
 *  BroadcastChannel, both structured-clone, so plain data only. 'presence'
 *  is never peer-authored: SharedWorkerTransport gets it computed by the
 *  worker from its own port roster, BroadcastChannelTransport computes it
 *  locally from the hello/bye peers it has observed (see that file). */
export type ProjectSyncPayload =
	| { kind: 'model-changed'; sheetPath: string; text: string }
	| { kind: 'selection'; refs: string[] }
	| { kind: 'presence'; peers: PresenceInfo[] };

/**
 * One project-scoped cross-tab connection — SharedWorkerTransport and
 * BroadcastChannelTransport are the two implementations (see
 * createProjectSyncTransport for the feature-detecting factory between
 * them); SyncedProjectStore is the only thing that talks to either through
 * this interface, so the choice of transport never leaks into editor code.
 * See the harmonic-munching-trinket plan's Phase 6.
 */
export interface ProjectSyncTransport {
	readonly peerId: string;

	connect(view: DocumentKind, sheetPath: string | null): void;

	/** Re-announces this peer's view/sheet without a full reconnect —
	 *  called whenever the local tab navigates within an already-open
	 *  project (switching sheets, or Schematic ↔ PCB). */
	updatePresence(view: DocumentKind, sheetPath: string | null): void;

	disconnect(): void;

	publish(payload: ProjectSyncPayload): void;

	onMessage(handler: (payload: ProjectSyncPayload, fromPeerId: string) => void): () => void;
}
