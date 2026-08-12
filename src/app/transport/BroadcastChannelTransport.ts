import type { DocumentKind }                             from '../ActiveDocument';
import type { PresenceInfo }                             from '../ProjectStore';
import type { ProjectSyncPayload, ProjectSyncTransport } from './ProjectSyncTransport';

type WireMessage =
	| { type: 'hello'; peerId: string; view: DocumentKind; sheetPath: string | null }
	| { type: 'bye'; peerId: string }
	| { type: 'relay'; peerId: string; payload: ProjectSyncPayload };

/**
 * Fallback transport for browsers without SharedWorker — the real-world gap
 * is Android (Chrome-for-Android/Samsung Internet never shipped it, see the
 * harmonic-munching-trinket plan). No central process exists here to hold a
 * peer roster, so each tab builds its own by exchanging hello/bye
 * broadcasts: a joining tab announces itself, and any peer hearing a hello
 * from someone it doesn't already know replies with its own hello — so a
 * late-joining tab still learns about everyone already there, with no
 * server. Does not evict a peer that vanished without sending 'bye' (a
 * crashed tab, not a closed one) — a disclosed limitation of this
 * foundational pass, not something Phase 7's selection/highlight work
 * depends on.
 */
export class BroadcastChannelTransport implements ProjectSyncTransport {
	readonly peerId = crypto.randomUUID();
	protected channel: BroadcastChannel | null = null;
	protected readonly peers = new Map<string, PresenceInfo>();
	protected readonly handlers = new Set<(payload: ProjectSyncPayload, fromPeerId: string) => void>();
	protected selfView: DocumentKind = 'schematic';
	protected selfSheetPath: string | null = null;

	constructor(protected readonly projectId: string) {}

	connect(view: DocumentKind, sheetPath: string | null): void {
		if (this.channel) {
			return;
		}
		this.selfView = view;
		this.selfSheetPath = sheetPath;
		this.channel = new BroadcastChannel(`kionline-project-sync:${ this.projectId }`);
		this.channel.addEventListener('message', (event: MessageEvent<WireMessage>) => this.handleWireMessage(event.data));
		this.broadcastHello();
	}

	updatePresence(view: DocumentKind, sheetPath: string | null): void {
		this.selfView = view;
		this.selfSheetPath = sheetPath;
		this.broadcastHello();
	}

	disconnect(): void {
		if (!this.channel) {
			return;
		}
		this.channel.postMessage({ type: 'bye', peerId: this.peerId } satisfies WireMessage);
		this.channel.close();
		this.channel = null;
		this.peers.clear();
	}

	publish(payload: ProjectSyncPayload): void {
		this.channel?.postMessage({ type: 'relay', peerId: this.peerId, payload } satisfies WireMessage);
	}

	onMessage(handler: (payload: ProjectSyncPayload, fromPeerId: string) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	protected broadcastHello(): void {
		this.channel?.postMessage(
			{ type: 'hello', peerId: this.peerId, view: this.selfView, sheetPath: this.selfSheetPath } satisfies WireMessage);
	}

	protected handleWireMessage(message: WireMessage): void {
		if (message.peerId === this.peerId) {
			return;
		}
		if (message.type === 'hello') {
			const isNewPeer = !this.peers.has(message.peerId);
			this.peers.set(message.peerId, { peerId: message.peerId, view: message.view, sheetPath: message.sheetPath });
			this.emitPresence();
			if (isNewPeer) {
				// Reply so a peer that only just heard about us (e.g. it
				// connected before we did, and missed our own first hello)
				// learns about us too. Bounded, not infinite: this fires once
				// per distinct newly-seen peer, and that peer already has us
				// on file by the time it'd otherwise reply again.
				this.broadcastHello();
			}
			return;
		}
		if (message.type === 'bye') {
			if (this.peers.delete(message.peerId)) {
				this.emitPresence();
			}
			return;
		}
		for (const handler of this.handlers) {
			handler(message.payload, message.peerId);
		}
	}

	protected emitPresence(): void {
		const payload: ProjectSyncPayload = { kind: 'presence', peers: [...this.peers.values()] };
		for (const handler of this.handlers) {
			handler(payload, 'local');
		}
	}
}
