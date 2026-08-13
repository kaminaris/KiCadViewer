import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { Vec2 }               from '@kicad-render/math/Vec2';

/** Set to false to silence dbg() without touching every call site. */
const DEBUG = true;

/**
 * Owns the bottom status text elements (status/coord/zoom)
 * and the debug-log helper — pure DOM writes, no business logic. Callers
 * decide WHAT to show; this class only knows HOW to show it.
 */
export class StatusBar {
	protected readonly statusEl = document.getElementById('status')!;
	protected readonly coordStatusEl = document.getElementById('coord-status')!;
	protected readonly zoomStatusEl = document.getElementById('zoom-status')!;
	protected readonly fpsStatusEl = document.getElementById('fps-status')!;
	protected readonly appVersionEl = document.getElementById('app-version');

	protected coordZoomFramePending = false;
	protected pendingScreenPos: Vec2 | undefined;
	protected lastCoord = '';
	protected lastZoom = '';
	protected displayUnit: 'mm' | 'mil' = 'mm';

	protected lastRenderTime: number | null = null;
	protected fps = 0;
	protected fpsIdleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor() {
		if (this.appVersionEl) {
			this.appVersionEl.textContent = `v${ __APP_VERSION__ } (${ __APP_COMMIT__ })`;
			this.appVersionEl.title = `Built ${ __APP_BUILD_TIME__ }`;
		}
	}

	dbg(...args: unknown[]): void {
		if (DEBUG) {
			console.log('[kionline]', ...args);
		}
	}

	setStatus(msg: string): void {
		this.statusEl.textContent = msg;
	}

	setScore(_text: string): void {
	}

	setHint(text: string): void {
		this.statusEl.textContent = text;
	}

	setDisplayUnit(unit: 'mm' | 'mil'): void {
		this.displayUnit = unit;
		this.lastCoord = '';
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
			const unit = this.displayUnit;
			const scale = unit === 'mil' ? 39.37007874 : 1;
			const precision = unit === 'mil' ? 1 : 2;
			const coord = world ? `X: ${ (world.x * scale).toFixed(precision) } ${ unit }  Y: ${ (world.y * scale).toFixed(precision) } ${ unit }` : this.lastCoord;
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

	/** Call once per actual repaint (session.onRender) — this app only
	 *  redraws on demand rather than every animation frame, so the reading
	 *  is render RATE during active interaction (pan/drag/zoom), not a
	 *  continuous browser frame-rate meter. Clears itself after a beat of
	 *  no repaints instead of leaving a stale number on screen. */
	recordRender(): void {
		const now = performance.now();
		if (this.lastRenderTime !== null) {
			const delta = now - this.lastRenderTime;
			if (delta > 0) {
				const instant = 1000 / delta;
				this.fps = this.fps ? this.fps * 0.8 + instant * 0.2 : instant;
				this.fpsStatusEl.textContent = `${ Math.round(this.fps) } fps`;
			}
		}
		this.lastRenderTime = now;
		clearTimeout(this.fpsIdleTimer);
		this.fpsIdleTimer = setTimeout(() => {
			this.fpsStatusEl.textContent = '';
			this.fps = 0;
			this.lastRenderTime = null;
		}, 1500);
	}
}
