import type { ProjectSyncTransport } from './ProjectSyncTransport';
import { SharedWorkerTransport }     from './SharedWorkerTransport';
import { BroadcastChannelTransport } from './BroadcastChannelTransport';

/** Feature-detects SharedWorker (Chrome/Edge/Firefox/Safari 16+ desktop,
 *  Safari iOS — the real-world gap is Android: Chrome-for-Android and
 *  Samsung Internet never shipped it) and falls back to BroadcastChannel
 *  there — mirrors BrowserFsAdapter.getDirectoryPicker's truthy-optional-
 *  global feature-detect style. See the harmonic-munching-trinket plan's
 *  Phase 6. */
export function createProjectSyncTransport(projectId: string): ProjectSyncTransport {
	if (typeof SharedWorker !== 'undefined') {
		return new SharedWorkerTransport(projectId);
	}
	return new BroadcastChannelTransport(projectId);
}
