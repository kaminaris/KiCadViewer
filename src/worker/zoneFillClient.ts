import type { MmPath, ZoneFillJob }                           from '@kicad-render/paint/BoardZoneFill';
import type { ZoneFillWorkerRequest, ZoneFillWorkerResponse } from './zone-fill.worker';

/**
 * Main-thread entry point for zone filling: spawns a fresh dedicated worker
 * per call (zone filling is an infrequent, bursty action, not a persistent
 * channel like project-sync's SharedWorker — no benefit to keeping one
 * warm between fills) and resolves once every job has run.
 */
export function runZoneFillJobs(
	jobs: ZoneFillJob[],
	onProgress?: (done: number, total: number) => void
): Promise<{ zoneUuid: string; layer: string; points: MmPath }[]> {
	if (jobs.length === 0) {
		return Promise.resolve([]);
	}

	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./zone-fill.worker.ts', import.meta.url), { type: 'module' });

		worker.onmessage = (event: MessageEvent<ZoneFillWorkerResponse>) => {
			const message = event.data;
			if (message.type === 'progress') {
				onProgress?.(message.done, message.total);
			}
			else if (message.type === 'done') {
				worker.terminate();
				resolve(message.results);
			}
			else if (message.type === 'error') {
				worker.terminate();
				reject(new Error(message.message));
			}
		};
		worker.onerror = event => {
			worker.terminate();
			reject(new Error(event.message || 'Zone fill worker error'));
		};

		const request: ZoneFillWorkerRequest = { jobs };
		worker.postMessage(request);
	});
}
