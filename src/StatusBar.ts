import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { Vec2 }               from '@kicad-render/math/Vec2';

/** Set to false to silence dbg() without touching every call site. */
const DEBUG = true;

/**
 * Owns the bottom/side status text elements (status/score/hint/coord/zoom)
 * and the debug-log helper — pure DOM writes, no business logic. Callers
 * decide WHAT to show; this class only knows HOW to show it.
 */
export class StatusBar {
	protected readonly statusEl = document.getElementById('status')!;
	protected readonly scoreEl = document.getElementById('score')!;
	protected readonly hintEl = document.getElementById('hint')!;
	protected readonly coordStatusEl = document.getElementById('coord-status')!;
	protected readonly zoomStatusEl = document.getElementById('zoom-status')!;

	protected coordZoomFramePending = false;
	protected pendingScreenPos: Vec2 | undefined;
	protected lastCoord = '';
	protected lastZoom = '';

	dbg(...args: unknown[]): void {
		if (DEBUG) {
			console.log('[kicad-viewer]', ...args);
		}
	}

	setStatus(msg: string): void {
		this.statusEl.textContent = msg;
	}

	setScore(text: string): void {
		this.scoreEl.textContent = text;
	}

	setHint(text: string): void {
		this.hintEl.textContent = text;
	}

	/** rAF-throttled coord/zoom readout — coalesces rapid mousemove-driven
	 *  calls into one DOM write per frame, and skips the write entirely when
	 *  the displayed text hasn't actually changed. */
	updateCoordZoom(session: KicadRenderSession | null, screenPos?: Vec2): void {
		this.pendingScreenPos = screenPos ?? this.pendingScreenPos;
		if (this.coordZoomFramePending) {
			return;
		}
		this.coordZoomFramePending = true;
		requestAnimationFrame(() => {
			this.coordZoomFramePending = false;
			const world = session && this.pendingScreenPos ? session.screenToWorld(this.pendingScreenPos) : null;
			const coord = world ? `X: ${ world.x.toFixed(2) }  Y: ${ world.y.toFixed(2) }` : this.lastCoord;
			const zoom = `Zoom: ${ session && Number.isFinite(session.camera.zoom) ?
				`${ session.camera.zoom.toFixed(2) }×` : '—' }`;
			if (coord !== this.lastCoord) {
				this.coordStatusEl.textContent = coord;
				this.lastCoord = coord;
			}
			if (zoom !== this.lastZoom) {
				this.zoomStatusEl.textContent = zoom;
				this.lastZoom = zoom;
			}
		});
	}
}
