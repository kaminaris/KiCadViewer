import type { MmPath, ZoneFillJob } from '@kicad-render/paint/BoardZoneFill';
import { runZoneFillJob } from '@kicad-render/paint/BoardZoneFill';

/**
 * Dedicated (non-shared) worker: runs the Clipper2 zone-fill pipeline off
 * the main thread. Real KiCad shows a modeless progress dialog while it
 * fills zones on its own worker threads — this mirrors that instead of
 * blocking the UI for the few seconds a board with several zones/obstacles
 * can take (confirmed the actual cause: BoardZoneFill.ts's Clipper2 booleans
 * are synchronous CPU work, same as any other polygon-clipping library).
 *
 * One job per (zone, layer) — see BoardZoneFill.ts's ZoneFillJob doc
 * comment — so progress can be reported per job rather than only once per
 * zone (a multi-layer zone reports several progress ticks).
 */

export interface ZoneFillWorkerRequest {
	jobs: ZoneFillJob[];
}

export type ZoneFillWorkerResponse =
	| { type: 'progress'; done: number; total: number }
	| { type: 'done'; results: { zoneUuid: string; layer: string; points: MmPath }[] }
	| { type: 'error'; message: string };

// 'DedicatedWorkerGlobalScope' isn't in this project's single DOM-lib
// tsconfig (see project-sync.worker.ts's identical note) — narrowed
// locally via a minimal postMessage/addEventListener shape instead of
// widening the whole program's lib set for one file.
declare const self: {
	postMessage(message: ZoneFillWorkerResponse): void;
	addEventListener(type: 'message', listener: (event: MessageEvent<ZoneFillWorkerRequest>) => void): void;
};

self.addEventListener('message', event => {
	const { jobs } = event.data;
	try {
		const results: { zoneUuid: string; layer: string; points: MmPath }[] = [];
		for (let i = 0; i < jobs.length; i++) {
			results.push(...runZoneFillJob(jobs[i]!));
			self.postMessage({ type: 'progress', done: i + 1, total: jobs.length });
		}
		self.postMessage({ type: 'done', results });
	}
	catch (err) {
		self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
});
