import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { Vec2 }                    from '@kicad-render/math/Vec2';
import type { AppMode }            from '../app/AppState';
import { PendingShapeTracker, type PendingShape } from './PendingShape';
import type { BoardTool }          from './BoardToolbar';

const RECT_SELECT_MOVE_THRESHOLD_PX = 4;

type BoardGesture =
	| { kind: 'none' }
	| { kind: 'pan'; lastScreen: Vec2; moved: boolean }
	| { kind: 'single'; paintId: string; lastSnapped: Vec2 }
	| { kind: 'group'; lastSnapped: Vec2 }
	| { kind: 'rect'; originWorld: Vec2; originScreen: Vec2; moved: boolean };

export interface BoardPointerControllerDeps {
	canvas: HTMLCanvasElement;
	/** The WebGL canvas overlaid at the same position — see PointerController's
	 *  identical field for why both need their own listeners. */
	canvasGl: HTMLCanvasElement;
	screenPosFromEvent(e: MouseEvent): Vec2;
	getSession(): KicadRenderSession | null;
	getMode(): AppMode;
	getGridSpacingMm(): number;
	snap(value: number): number;
	updateStatusBar(screenPos?: Vec2): void;
	refreshBoardText(session: KicadRenderSession): void;
	getTool(): BoardTool;
	setTool(tool: BoardTool): void;
	getActiveLayer(): string;
	setStatus(message: string): void;
	refreshAppearance(): void;
	showPropertiesModal(id: string): void;
	getHighlightNetEnabled(): boolean;
}

/**
 * Board-side counterpart to PointerController — deliberately a separate,
 * much smaller class rather than a generalized branch inside
 * PointerController: that class's deps interface is already ~40 members
 * deep in schematic-only vocabulary (getRuleAreaPoints, getCurrentPowerKind,
 * getLineChainStart, ...), and board's own gesture vocabulary (route
 * corners, active layer, net inheritance) diverges immediately. Mirrors
 * BoardAppearancePanel's existing precedent
 * of a small, self-contained class that self-gates on document type rather
 * than generalizing the schematic equivalent.
 *
 * Current scope: select + drag one or more footprints (by pad or, now that
 * BoardPainter has a synthetic whole-body hit item, anywhere on the
 * footprint), rectangle multi-select, interactive 45° track routing, and
 * via placement. Rotate/flip/delete and layer hotkeys live in
 * KeyboardController, mirroring the schematic editor's separation.
 */
export class BoardPointerController {
	/** mouseup/mousemove are bound at window level (mirrors PointerController)
	 *  so a drag that ends off-canvas still releases — but that means every
	 *  mouseup on the page reaches these handlers, including clicks on
	 *  unrelated UI (e.g. the Appearance panel). Track whether the current
	 *  gesture actually started on the canvas so window-level handlers can
	 *  ignore ones that don't belong to them, instead of reacting to
	 *  everything and potentially racing a UI panel's own click/change
	 *  handlers (see PointerController's identical fix). */
	protected pointerDownOnCanvas = false;
	protected gesture: BoardGesture = { kind: 'none' };
	protected dragUndoCaptured = false;
	/** A right-button pan must not also open the board context menu when the
	 *  browser emits its contextmenu event after mouseup. A stationary
	 *  right-click still intentionally opens that menu. */
	protected suppressNextContextMenu = false;
	protected readonly pending = new PendingShapeTracker();
	protected lastPointerScreen: Vec2 | null = null;
	/** Persistent keyboard Move state. The cursor's snapped position is kept
	 *  separately from pointer-down gestures, so M can grab a selection and
	 *  navigation remains available until placement is confirmed. */
	protected interactiveMove: {
		ids: string[];
		lastSnapped: Vec2;
		undoCaptured: boolean;
		moved: boolean;
	} | null = null;
	protected static readonly trackWidth = 0.25;
	protected static readonly viaSize = 0.6;
	protected static readonly viaDrill = 0.3;

	constructor(protected readonly deps: BoardPointerControllerDeps) {
		for (const el of [deps.canvas, deps.canvasGl]) {
			el.addEventListener('mousedown', event => this.onMouseDown(event));
			el.addEventListener('dblclick', event => this.onDoubleClick(event));
			el.addEventListener('contextmenu', event => this.onContextMenu(event));
		}
		window.addEventListener('mousemove', event => this.onMouseMove(event));
		window.addEventListener('mouseup', event => this.onMouseUp(event));
		window.addEventListener('kionline:board-command', event => {
			const command = (event as CustomEvent<string>).detail;
			if (command === 'route-track') this.setTool('route');
			else if (command === 'place-via') this.setTool('via');
			else if (command === 'set-grid-origin') this.setTool('grid-origin');
			else if (command === 'set-drill-origin') this.setTool('drill-origin');
			else if (command === 'reset-grid-origin') this.resetOrigin('grid');
			else if (command === 'reset-drill-origin') this.resetOrigin('drill-place');
		});
	}

	setTool(tool: BoardTool): void {
		if (tool !== 'route') {
			this.cancelRoute();
		}
		this.deps.setTool(tool);
		this.deps.setStatus(tool === 'route'
			? `Route tracks on ${ this.deps.getActiveLayer() } — click to start and add corners; Enter/double-click finishes.`
			: tool === 'via' ? 'Place vias — click copper to inherit its net.'
				: tool === 'grid-origin' ? 'Set Grid Origin — click a grid point.'
					: tool === 'drill-origin' ? 'Set Drill/Place File Origin — click a grid point.' : 'PCB select tool active.');
	}

	finishRoute(): boolean {
		if (this.pending.current.kind !== 'route') {
			return false;
		}
		this.pending.clear();
		this.deps.getSession()?.setEditPreview(null);
		this.deps.setStatus('Route finished.');
		return true;
	}

	cancelRoute(): boolean {
		if (this.pending.current.kind !== 'route') {
			return false;
		}
		this.pending.clear();
		this.deps.getSession()?.setEditPreview(null);
		this.deps.setStatus('Route cancelled.');
		return true;
	}

	placeViaAtLastPointer(): boolean {
		const session = this.deps.getSession();
		if (!session || !this.lastPointerScreen || session.documentTypeLoaded !== 'board') {
			return false;
		}
		return this.placeVia(session, this.lastPointerScreen, true);
	}

	hasInteractiveMove(): boolean {
		return this.interactiveMove !== null;
	}

	beginInteractiveMove(): boolean {
		const session = this.deps.getSession();
		if (!session || session.documentTypeLoaded !== 'board' || this.deps.getMode() !== 'edit'
			|| session.selectionIds.size === 0) {
			return false;
		}
		const screen = this.lastPointerScreen ?? new Vec2(this.deps.canvas.width / 2, this.deps.canvas.height / 2);
		this.interactiveMove = {
			ids: [...session.selectionIds],
			lastSnapped: this.snappedWorld(session, screen),
			undoCaptured: false,
			moved: false,
		};
		// See beginBoardDragPreview's doc comment — no-ops for any selected id
		// that isn't a footprint (tracks/vias keep going through the older
		// per-frame rebuild path, unaffected).
		session.beginBoardDragPreview(this.interactiveMove.ids);
		this.deps.setStatus('Move active — click or Enter to place; Escape cancels.');
		return true;
	}

	finishInteractiveMove(): boolean {
		const move = this.interactiveMove;
		if (!move) {
			return false;
		}
		const session = this.deps.getSession();
		this.interactiveMove = null;
		if (session) {
			// Bakes the preview footprint(s)' final position back into the
			// real scene — must run even when nothing actually moved, since
			// beginBoardDragPreview already pulled them out of it.
			session.endBoardDragPreview();
			if (move.moved) {
				this.deps.refreshBoardText(session);
			}
		}
		this.deps.refreshAppearance();
		this.deps.setStatus(move.moved ? 'Move finished.' : 'Move finished without changes.');
		return true;
	}

	async cancelInteractiveMove(): Promise<boolean> {
		const move = this.interactiveMove;
		if (!move) {
			return false;
		}
		this.interactiveMove = null;
		const session = this.deps.getSession();
		if (session) {
			// If an undo snapshot was captured, cancelLatestUndoSnapshot()
			// below does a full board reload, which already clears
			// dragPreviewFootprints itself (see loadBoardText) — but Escape
			// before any real movement never captures one, so the preview
			// footprint(s) would otherwise stay pulled out of the scene
			// forever. Safe/cheap to call unconditionally either way.
			session.endBoardDragPreview();
		}
		if (session && move.undoCaptured) {
			await session.cancelLatestUndoSnapshot();
			session.selectMultiple(move.ids, 'replace');
			this.deps.refreshBoardText(session);
		}
		this.deps.refreshAppearance();
		this.deps.setStatus('Move cancelled.');
		return true;
	}

	nudgeInteractiveMove(dx: number, dy: number): boolean {
		const spacing = this.deps.getGridSpacingMm();
		const deltaX = dx * spacing;
		const deltaY = dy * spacing;
		if (!this.translateInteractiveMove(deltaX, deltaY)) {
			return false;
		}
		return true;
	}

	protected onMouseDown(e: MouseEvent): void {
		const session = this.deps.getSession();
		if (!session || session.documentTypeLoaded !== 'board') {
			return;
		}
		this.pointerDownOnCanvas = true;
		const screenPos = this.deps.screenPosFromEvent(e);
		this.lastPointerScreen = screenPos;
		// Navigation deliberately comes before the active PCB tool. This keeps
		// the camera available while routing or placing vias, just like KiCad.
		if (e.button === 1 || e.button === 2) {
			this.gesture = { kind: 'pan', lastScreen: screenPos, moved: false };
			e.preventDefault();
			return;
		}
		if (this.interactiveMove && e.button === 0) {
			this.finishInteractiveMove();
			e.preventDefault();
			return;
		}
		// Works regardless of view/edit mode, matching schematic's identical
		// click-to-highlight-net behavior (PointerController.onMouseDown).
		if (this.deps.getHighlightNetEnabled() && e.button === 0) {
			const highlighted = session.highlightBoardNetAtScreen(screenPos);
			if (highlighted) {
				this.deps.setStatus(`Highlighting net "${ session.currentHighlightedBoardNetName ?? '' }".`);
				e.preventDefault();
				return;
			}
		}
		if (this.deps.getMode() !== 'edit' || e.button !== 0) {
			return;
		}
		if (this.deps.getTool() === 'route') {
			this.routeClick(session, screenPos, e.detail >= 2);
			e.preventDefault();
			return;
		}
		if (this.deps.getTool() === 'via') {
			this.placeVia(session, screenPos);
			e.preventDefault();
			return;
		}
		if (this.deps.getTool() === 'grid-origin' || this.deps.getTool() === 'drill-origin') {
			const point = this.snappedWorld(session, screenPos);
			const originKind = this.deps.getTool() === 'grid-origin' ? 'grid' : 'drill-place';
			if (session.setBoardOrigin(originKind, point.x, point.y)) {
				this.deps.refreshBoardText(session);
				this.deps.setStatus(`${ originKind === 'grid' ? 'Grid' : 'Drill/Place File' } Origin set to ${ point.x.toFixed(3) }, ${ point.y.toFixed(3) } mm.`);
			}
			this.setTool('select');
			e.preventDefault();
			return;
		}
		const hit = session.hitTestAtScreen(screenPos);
		this.dragUndoCaptured = false;
		if (!hit) {
			// Empty-space mousedown begins a rect-select gesture — onMouseUp
			// decides whether it was a real drag (marquee-select) or a plain
			// click (clear selection), matching PointerController's identical
			// rect-select convention.
			this.gesture = { kind: 'rect', originWorld: session.screenToWorld(screenPos), originScreen: screenPos, moved: false };
			return;
		}
		if (hit.kind !== 'pad' && hit.kind !== 'footprint') {
			// Tracks, vias, and other board-level items are selectable even
			// though Phase 1 only supports dragging whole footprints. Keeping
			// these as a click-only gesture lets Delete and the context menu act
			// on imported routing without accidentally treating the click as an
			// empty-space marquee.
			session.select(hit.id);
			this.deps.refreshAppearance();
			this.gesture = { kind: 'none' };
			e.preventDefault();
			return;
		}
		// Normalize a pad hit to its owning footprint's own id — selectedIds
		// (populated from rect-select's footprint-level results) never
		// contains a raw pad id, so checking membership with the un-
		// normalized hit.id would never find a match and group-drag could
		// never trigger.
		const footprintId = session.footprintPaintIdForHit(hit.id);
		if (session.selectionIds.size > 1 && session.selectionIds.has(footprintId)) {
			this.gesture = { kind: 'group', lastSnapped: this.snappedWorld(session, screenPos) };
			// See KicadRenderSession.beginBoardDragPreview's doc comment —
			// pulls every selected footprint out of the real (static-buffer)
			// scene up front so the drag's per-frame cost stays cheap.
			session.beginBoardDragPreview(session.selectionIds);
			e.preventDefault();
			return;
		}
		session.select(footprintId);
		this.deps.refreshAppearance();
		this.gesture = { kind: 'single', paintId: footprintId, lastSnapped: this.snappedWorld(session, screenPos) };
		session.beginBoardDragPreview([footprintId]);
		e.preventDefault();
	}

	protected onMouseMove(e: MouseEvent): void {
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		const screenPos = this.deps.screenPosFromEvent(e);
		this.lastPointerScreen = screenPos;
		if (session.documentTypeLoaded === 'board') {
			session.updateBoardPointerScreen(screenPos);
			if (!this.deps.getHighlightNetEnabled()) {
				session.clearBoardNetHighlight();
			}
		}
		if (session.documentTypeLoaded === 'board' && this.interactiveMove && this.gesture.kind !== 'pan') {
			this.moveToScreen(session, screenPos);
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (session.documentTypeLoaded === 'board' && this.deps.getTool() === 'route') {
			this.updateRoutePreview(session, screenPos);
		}
		if (!this.pointerDownOnCanvas || this.gesture.kind === 'none') {
			return;
		}
		if (this.gesture.kind === 'pan') {
			const dx = screenPos.x - this.gesture.lastScreen.x;
			const dy = screenPos.y - this.gesture.lastScreen.y;
			if (dx !== 0 || dy !== 0) {
				session.pan(dx, dy);
				this.gesture = { kind: 'pan', lastScreen: screenPos, moved: true };
			}
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'single') {
			const snapped = this.snappedWorld(session, screenPos);
			const dx = snapped.x - this.gesture.lastSnapped.x;
			const dy = snapped.y - this.gesture.lastSnapped.y;
			if (dx !== 0 || dy !== 0) {
				this.captureUndoOnce(session, 'Move footprint');
				// Delta from the last frame's snapped position, exactly like
				// 'group' below — NOT moveFootprintByPaintId(paintId,
				// snapped.x, snapped.y), which sets the footprint's ORIGIN
				// directly to the cursor's world position. That silently
				// snapped the part so its origin (its center/reference
				// point, not wherever on the footprint was actually
				// clicked) jumped to the cursor on the very first mousemove
				// — the part should track the cursor's MOVEMENT, keeping
				// whatever offset existed between the click point and the
				// origin when the drag started.
				const moved = session.translateBoardSelection([this.gesture.paintId], dx, dy);
				if (moved) {
					// See the 'group' branch below — no per-frame text
					// refresh during the drag.
					session.updateBoardDragPreview();
				}
				this.gesture = { kind: 'single', paintId: this.gesture.paintId, lastSnapped: snapped };
			}
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'group') {
			const snapped = this.snappedWorld(session, screenPos);
			const dx = snapped.x - this.gesture.lastSnapped.x;
			const dy = snapped.y - this.gesture.lastSnapped.y;
			if (dx !== 0 || dy !== 0) {
				this.captureUndoOnce(session, 'Move footprints');
				const moved = session.translateBoardSelection([...session.selectionIds], dx, dy);
				if (moved) {
					// See the 'single' branch above — no per-frame text refresh
					// during the drag.
					session.updateBoardDragPreview();
				}
				this.gesture = { kind: 'group', lastSnapped: snapped };
			}
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'rect') {
			const worldPos = session.screenToWorld(screenPos);
			if (!this.gesture.moved
				&& Math.hypot(screenPos.x - this.gesture.originScreen.x, screenPos.y - this.gesture.originScreen.y)
					> RECT_SELECT_MOVE_THRESHOLD_PX) {
				this.gesture = { ...this.gesture, moved: true };
			}
			const mode: 'contained' | 'touching' = worldPos.x >= this.gesture.originWorld.x ? 'contained' : 'touching';
			session.setEditPreview({
				kind: 'selection-box',
				origin: this.gesture.originWorld,
				cursor: worldPos,
				mode,
				selectMode: this.selectionModeFromModifiers(e)
			});
			this.deps.updateStatusBar(screenPos);
		}
	}

	protected onMouseUp(e: MouseEvent): void {
		const wasCanvasGesture = this.pointerDownOnCanvas;
		this.pointerDownOnCanvas = false;
		if (!wasCanvasGesture) {
			return;
		}
		const gesture = this.gesture;
		const wasDragging = this.dragUndoCaptured;
		this.gesture = { kind: 'none' };
		this.dragUndoCaptured = false;
		if (gesture.kind === 'pan') {
			if (e.button === 2 && gesture.moved) {
				this.suppressNextContextMenu = true;
			}
			return;
		}
		if (gesture.kind === 'single' || gesture.kind === 'group') {
			// Bakes the drag-preview footprint(s) back into the real scene —
			// see KicadRenderSession.endBoardDragPreview's doc comment. Must
			// run even for a plain click with no actual movement, since
			// onMouseDown's beginBoardDragPreview already pulled them out of
			// it. No separate ratsnest resync needed here: every mousemove
			// during the drag already kept it correct (endBoardDragPreview
			// itself does one last net-scoped incremental refresh).
			const session = this.deps.getSession();
			session?.endBoardDragPreview();
			// The one text-refresh (full AST serialize + save/sync) for this
			// whole gesture — see onMouseMove's 'single'/'group' branches for
			// why it's not called per-frame anymore. wasDragging (captured
			// before dragUndoCaptured was reset above) is true only once an
			// actual move happened, matching captureUndoOnce's own gate.
			if (session && wasDragging) {
				this.deps.refreshBoardText(session);
			}
			return;
		}
		if (gesture.kind !== 'rect') {
			return;
		}
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		if (gesture.moved) {
			const worldPos = session.screenToWorld(this.deps.screenPosFromEvent(e));
			const mode: 'contained' | 'touching' = worldPos.x >= gesture.originWorld.x ? 'contained' : 'touching';
			const hitIds = session.hitTestBoardRect(gesture.originWorld, worldPos, mode);
			session.selectMultiple(hitIds, this.selectionModeFromModifiers(e));
		}
		else if (!e.shiftKey && !e.ctrlKey) {
			session.select(null);
		}
		session.setEditPreview(null);
		this.deps.refreshAppearance();
	}

	protected onContextMenu(e: MouseEvent): void {
		if (!this.suppressNextContextMenu) {
			return;
		}
		this.suppressNextContextMenu = false;
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	protected onDoubleClick(e: MouseEvent): void {
		if (this.deps.getMode() !== 'edit' || this.deps.getTool() !== 'select') return;
		const session = this.deps.getSession();
		if (!session || session.documentTypeLoaded !== 'board') return;
		const hit = session.hitTestAtScreen(this.deps.screenPosFromEvent(e));
		if (!hit) return;
		this.deps.showPropertiesModal(hit.id);
		e.preventDefault();
	}

	protected snappedWorld(session: KicadRenderSession, screenPos: Vec2): Vec2 {
		const world = session.screenToWorld(screenPos);
		return new Vec2(this.deps.snap(world.x), this.deps.snap(world.y));
	}

	protected resetOrigin(kind: 'grid' | 'drill-place'): void {
		const session = this.deps.getSession();
		if (!session || session.documentTypeLoaded !== 'board' || !session.resetBoardOrigin(kind)) {
			return;
		}
		this.deps.refreshBoardText(session);
		this.deps.setStatus(`${ kind === 'grid' ? 'Grid' : 'Drill/Place File' } Origin reset to 0, 0.`);
	}

	protected moveToScreen(session: KicadRenderSession, screenPos: Vec2): void {
		const move = this.interactiveMove;
		if (!move) {
			return;
		}
		const snapped = this.snappedWorld(session, screenPos);
		if (this.translateInteractiveMove(snapped.x - move.lastSnapped.x, snapped.y - move.lastSnapped.y)) {
			move.lastSnapped = snapped;
		}
	}

	protected translateInteractiveMove(dx: number, dy: number): boolean {
		const move = this.interactiveMove;
		const session = this.deps.getSession();
		if (!move || !session || (dx === 0 && dy === 0)) {
			return false;
		}
		if (!move.undoCaptured) {
			session.pushUndoSnapshot('Move selection');
			move.undoCaptured = true;
		}
		if (!session.translateBoardSelection(move.ids, dx, dy)) {
			return false;
		}
		move.moved = true;
		// See updateBoardDragPreview's doc comment — cheap, drives the live
		// per-frame redraw for whatever footprints beginInteractiveMove
		// pulled into the preview.
		session.updateBoardDragPreview();
		return true;
	}

	protected captureUndoOnce(session: KicadRenderSession, label: string): void {
		if (!this.dragUndoCaptured) {
			session.pushUndoSnapshot(label);
			this.dragUndoCaptured = true;
		}
	}

	protected selectionModeFromModifiers(e: MouseEvent): 'replace' | 'add' | 'subtract' {
		if (e.shiftKey && e.ctrlKey) {
			return 'subtract';
		}
		if (e.shiftKey || e.ctrlKey) {
			return 'add';
		}
		return 'replace';
	}

	protected routeClick(session: KicadRenderSession, screenPos: Vec2, finish: boolean): void {
		const point = this.snappedWorld(session, screenPos);
		const pending = this.pending.current;
		if (pending.kind !== 'route') {
			this.pending.set({
				kind: 'route',
				netId: session.netIdAtScreen(screenPos),
				layer: this.deps.getActiveLayer(),
				corners: [point]
			});
			this.updateRoutePreview(session, screenPos);
			this.deps.setStatus(`Routing on ${ this.deps.getActiveLayer() } — click to add a corner.`);
			return;
		}
		const added = this.commitRouteTo(session, pending, point);
		if (added) {
			this.deps.refreshBoardText(session);
			this.deps.refreshAppearance();
		}
		this.pending.set({ ...pending, layer: this.deps.getActiveLayer(), corners: [...pending.corners, point] });
		if (finish) {
			this.finishRoute();
		}
		else {
			this.updateRoutePreview(session, screenPos);
		}
	}

	protected updateRoutePreview(session: KicadRenderSession, screenPos: Vec2): void {
		const pending = this.pending.current;
		if (pending.kind !== 'route') {
			return;
		}
		const from = pending.corners[pending.corners.length - 1]!;
		const cursor = this.snappedWorld(session, screenPos);
		const path = this.miterPath(from, cursor);
		session.setEditPreview({
			kind: 'route',
			points: path.slice(0, -1),
			cursor: path[path.length - 1]!,
			width: BoardPointerController.trackWidth
		});
	}

	protected miterPath(from: Vec2, to: Vec2): Vec2[] {
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) {
			return [from, to];
		}
		const diagonal = Math.min(Math.abs(dx), Math.abs(dy));
		const corner = new Vec2(
			from.x + Math.sign(dx) * diagonal,
			from.y + Math.sign(dy) * diagonal);
		return [from, corner, to];
	}

	protected placeVia(session: KicadRenderSession, screenPos: Vec2, continueRoute = false): boolean {
		const point = this.snappedWorld(session, screenPos);
		const pending = this.pending.current;
		const netId = pending.kind === 'route' ? pending.netId : session.netIdAtScreen(screenPos);
		const routedToVia = pending.kind === 'route' && continueRoute
			? this.commitRouteTo(session, pending, point)
			: 0;
		const id = session.addVia(
			point.x, point.y, BoardPointerController.viaSize, BoardPointerController.viaDrill,
			['F.Cu', 'B.Cu'], netId, routedToVia === 0);
		if (!id) {
			return false;
		}
		this.deps.refreshBoardText(session);
		this.deps.refreshAppearance();
		if (pending.kind === 'route' && continueRoute) {
			this.pending.set({ ...pending, corners: [...pending.corners, point] });
		}
		this.deps.setStatus(`Via placed at ${ point.x.toFixed(3) }, ${ point.y.toFixed(3) } mm.`);
		return true;
	}

	protected commitRouteTo(
		session: KicadRenderSession,
		pending: Extract<PendingShape, { kind: 'route' }>,
		point: Vec2
	): number {
		const from = pending.corners[pending.corners.length - 1] as Vec2;
		const path = this.miterPath(from, point);
		let added = 0;
		for (let index = 1; index < path.length; index++) {
			if (session.addTrackSegment(
				path[index - 1]!.x, path[index - 1]!.y,
				path[index]!.x, path[index]!.y,
				BoardPointerController.trackWidth, this.deps.getActiveLayer(), pending.netId,
				added === 0)) {
				added++;
			}
		}
		return added;
	}
}
