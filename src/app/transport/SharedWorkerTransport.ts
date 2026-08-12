import type { DocumentKind }                             from '../ActiveDocument';
import type { ProjectSyncPayload, ProjectSyncTransport } from './ProjectSyncTransport';
import { BroadcastChannelTransport }                     from './BroadcastChannelTransport';

type WorkerRequest =
	| { type: 'join'; projectId: string; peerId: string; view: DocumentKind; sheetPath: string | null }
	| { type: 'update-presence'; view: DocumentKind; sheetPath: string | null }
	| { type: 'leave' }
	| { type: 'relay'; payload: ProjectSyncPayload };

interface WorkerResponse {
	type: 'relay';
	peerId: string;
	payload: ProjectSyncPayload;
}

/**
 * Primary transport — a single SharedWorker process (src/worker/project-
 * sync.worker.ts) shared by every tab of this origin relays messages
 * between whichever tabs have the same project open, and computes presence
 * from its own port roster. See ProjectSyncTransport.ts and the
 * harmonic-munching-trinket plan's Phase 6.
 *
 * `typeof SharedWorker !== 'undefined'` (the createProjectSyncTransport
 * factory's own check) only proves the API exists, not that a worker will
 * actually load — confirmed in practice: some sandboxed/embedded Chromium
 * hosts advertise the constructor but fail every module SharedWorker with
 * "Failed to fetch a worker script", asynchronously, well after
 * construction returns without throwing. Since multi-tab support is a hard
 * requirement (not an edge case to degrade silently on), this class falls
 * back to BroadcastChannelTransport itself the moment that happens —
 * callers never see the difference, they just get onMessage callbacks
 * either way.
 */
export class SharedWorkerTransport implements ProjectSyncTransport {
	readonly peerId = crypto.randomUUID();
	protected worker: SharedWorker | null = null;
	protected fallback: BroadcastChannelTransport | null = null;
	protected readonly handlers = new Set<(payload: ProjectSyncPayload, fromPeerId: string) => void>();
	protected lastView: DocumentKind = 'schematic';
	protected lastSheetPath: string | null = null;

	constructor(protected readonly projectId: string) {}

	connect(view: DocumentKind, sheetPath: string | null): void {
		if (this.worker || this.fallback) {
			return;
		}
		this.lastView = view;
		this.lastSheetPath = sheetPath;
		try {
			const worker = new SharedWorker(new URL('../../worker/project-sync.worker.ts', import.meta.url), { type: 'module' });
			worker.onerror = () => this.fallBackToBroadcastChannel();
			worker.port.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
				const { peerId, payload } = event.data;
				for (const handler of this.handlers) {
					handler(payload, peerId);
				}
			});
			worker.port.start();
			this.worker = worker;
			this.send({ type: 'join', projectId: this.projectId, peerId: this.peerId, view, sheetPath });
		}
		catch {
			this.fallBackToBroadcastChannel();
		}
	}

	protected fallBackToBroadcastChannel(): void {
		if (this.fallback) {
			return;
		}
		this.worker?.port.close();
		this.worker = null;
		const fallback = new BroadcastChannelTransport(this.projectId);
		for (const handler of this.handlers) {
			fallback.onMessage(handler);
		}
		fallback.connect(this.lastView, this.lastSheetPath);
		this.fallback = fallback;
	}

	updatePresence(view: DocumentKind, sheetPath: string | null): void {
		this.lastView = view;
		this.lastSheetPath = sheetPath;
		if (this.fallback) {
			this.fallback.updatePresence(view, sheetPath);
			return;
		}
		this.send({ type: 'update-presence', view, sheetPath });
	}

	disconnect(): void {
		if (this.fallback) {
			this.fallback.disconnect();
			this.fallback = null;
			return;
		}
		if (!this.worker) {
			return;
		}
		this.send({ type: 'leave' });
		this.worker.port.close();
		this.worker = null;
	}

	publish(payload: ProjectSyncPayload): void {
		if (this.fallback) {
			this.fallback.publish(payload);
			return;
		}
		this.send({ type: 'relay', payload });
	}

	onMessage(handler: (payload: ProjectSyncPayload, fromPeerId: string) => void): () => void {
		this.handlers.add(handler);
		this.fallback?.onMessage(handler);
		return () => this.handlers.delete(handler);
	}

	protected send(message: WorkerRequest): void {
		this.worker?.port.postMessage(message);
	}
}
