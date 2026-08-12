import type { DocumentKind }        from '../app/ActiveDocument';
import type { PresenceInfo }        from '../app/ProjectStore';
import type { ProjectSyncPayload }  from '../app/transport/ProjectSyncTransport';

/**
 * SharedWorker: presence + relay only for whichever browser tabs currently
 * have the same project open — see the harmonic-munching-trinket plan's
 * Phase 6. Deliberately NOT the source of truth for project state (that
 * stays IndexedDB, via LocalProjectStore/SyncedProjectStore) — a tab that
 * opens after an edit sees it from IndexedDB regardless of whether any
 * other tab is still connected here, so losing this in-memory roster (a
 * worker crash, or simply zero tabs open) loses nothing durable.
 *
 * One SharedWorker process is shared by every tab of this origin
 * regardless of which project each tab has open, so peers are tracked
 * per-projectId, not globally.
 */

interface PeerEntry {
	port: MessagePort;
	peerId: string;
	view: DocumentKind;
	sheetPath: string | null;
}

type InboundMessage =
	| { type: 'join'; projectId: string; peerId: string; view: DocumentKind; sheetPath: string | null }
	| { type: 'update-presence'; view: DocumentKind; sheetPath: string | null }
	| { type: 'leave' }
	| { type: 'relay'; payload: ProjectSyncPayload };

interface OutboundMessage {
	type: 'relay';
	peerId: string;
	payload: ProjectSyncPayload;
}

const projects = new Map<string, Map<MessagePort, PeerEntry>>();

function presenceFor(peers: Map<MessagePort, PeerEntry>): PresenceInfo[] {
	return [...peers.values()].map(({ peerId, view, sheetPath }) => ({ peerId, view, sheetPath }));
}

function broadcastPresence(projectId: string): void {
	const peers = projects.get(projectId);
	if (!peers) {
		return;
	}
	const outbound: OutboundMessage = { type: 'relay', peerId: 'server', payload: { kind: 'presence', peers: presenceFor(peers) } };
	for (const entry of peers.values()) {
		entry.port.postMessage(outbound);
	}
}

function removePort(projectId: string, port: MessagePort): void {
	const peers = projects.get(projectId);
	if (!peers?.delete(port)) {
		return;
	}
	if (peers.size === 0) {
		projects.delete(projectId);
	}
	else {
		broadcastPresence(projectId);
	}
}

function handleConnection(port: MessagePort): void {
	let joinedProjectId: string | null = null;

	port.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
		const message = event.data;
		if (message.type === 'join') {
			joinedProjectId = message.projectId;
			let peers = projects.get(joinedProjectId);
			if (!peers) {
				peers = new Map();
				projects.set(joinedProjectId, peers);
			}
			peers.set(port, { port, peerId: message.peerId, view: message.view, sheetPath: message.sheetPath });
			broadcastPresence(joinedProjectId);
			return;
		}
		if (!joinedProjectId) {
			return;
		}
		if (message.type === 'leave') {
			removePort(joinedProjectId, port);
			joinedProjectId = null;
			return;
		}
		const peers = projects.get(joinedProjectId);
		const entry = peers?.get(port);
		if (!peers || !entry) {
			return;
		}
		if (message.type === 'update-presence') {
			entry.view = message.view;
			entry.sheetPath = message.sheetPath;
			broadcastPresence(joinedProjectId);
			return;
		}
		if (message.type === 'relay') {
			const outbound: OutboundMessage = { type: 'relay', peerId: entry.peerId, payload: message.payload };
			for (const [otherPort, otherEntry] of peers) {
				if (otherPort !== port) {
					otherEntry.port.postMessage(outbound);
				}
			}
		}
	});

	port.addEventListener('messageerror', () => { /* structured-clone failure on one message — ignore, keep the port alive */ });

	port.start();
}

// 'connect' only exists on SharedWorkerGlobalScope, which the project's
// single DOM-lib tsconfig doesn't include (adding "webworker" there would
// affect every other file under src/) — narrowed locally instead of
// widening the whole program's lib set for one file.
(self as unknown as { addEventListener(type: 'connect', listener: (event: { ports: MessagePort[] }) => void): void })
	.addEventListener('connect', event => {
		const port = event.ports[0];
		if (port) {
			handleConnection(port);
		}
	});
