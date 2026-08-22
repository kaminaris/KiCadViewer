import type { KicadRenderSession, HitResult, ViaDragFix, ResizeHandle, SelectionResizeBox } from '@kicad-render/KicadRenderSession';
import { Vec2 }                    from '@kicad-render/math/Vec2';
import type { AppMode }            from '../app/AppState';
import { PendingShapeTracker, type PendingShape } from './PendingShape';
import type { BoardTool }          from './BoardToolbar';
import { RouterNode }              from '@kicad-render/router/RouterNode';
import { shoveTrackPath } from '@kicad-render/router/RouterGeometry';
import { buildClearanceHull } from '@kicad-render/router/PnsHull';
import { walkaroundHull, pathLength } from '@kicad-render/router/PnsWalkaround';
import { simplifyWalkedPath } from '@kicad-render/router/PnsOptimizer';
import { dragViaChain, mergeCollinear } from '@kicad-render/router/PnsDragger';
import { resolveNetClass, resolveClearanceMm, type NetClassRules } from '@kicad-layout/NetClassResolver';
import type { RouterSettings } from '../app/ActiveDocument';

const RECT_SELECT_MOVE_THRESHOLD_PX = 4;
const RESIZE_HANDLE_ORDER: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se'];

/** What assembleTrackLine returns — the whole connected straight-track line
 *  a mid-segment drag operates on, not just the one segment clicked. See
 *  KicadRenderSession.assembleTrackLine's doc comment. */
interface AssembledTrackLine {
	segmentIds: string[];
	points: Vec2[];
	width: number;
	layer: string;
	netId: number | null;
}

/** A via-drag gesture's per-frame live preview: viaDragFanout's fixed
 *  anchor/startDiagonal carried alongside the chain freshly rebuilt from it
 *  toward the current cursor — see KicadRenderSession.viaDragFanout's doc
 *  comment for why the anchor must stay fixed for the whole gesture. */
interface ViaDragPreviewFix extends ViaDragFix {
	chain: Vec2[];
}

/** Mirrors KicadRenderSession.resolveBoardDragTargets' own return shape —
 *  see BoardGesture's `dragTargets` field for how a 'single'/'group'
 *  footprint drag caches this across frames. */
type BoardDragTargets = { itemIds: string[]; origins: any[]; bboxOnlyItems: any[] };

type BoardGesture =
	| { kind: 'none' }
	| { kind: 'pan'; lastScreen: Vec2; moved: boolean }
	// `moved` mirrors 'pan'/'rect's own flag: false until the first real
	// displacement — beginBoardDragPreview (which pulls a footprint out of
	// the static WebGL buffer) is deferred until then instead of running
	// eagerly on mousedown, so a plain click-to-select never pays a drag
	// setup/teardown cost it doesn't need. See onMouseMove's 'single'/
	// 'group' handling and endBoardDragPreview's own cheap no-op guard for
	// why this is safe.
	// `dragTargets`: undefined = not yet resolved (resolved lazily on the
	// first real move, see onMouseMove); null = resolved once and found
	// not to apply (a bare track/via/graphic in the selection, or a
	// renderer without incremental-translate support) — cached so the rest
	// of the gesture doesn't keep re-attempting it every frame; an object
	// = the fast path applies and this is what
	// KicadRenderSession.translateBoardDragFast needs each frame. See
	// that method's own doc comment for why this exists: without it, a
	// footprint drag's FIRST move still paid a full static-buffer rebuild
	// (via beginBoardDragPreview) even after plain click-to-select got
	// moved off that path.
	| { kind: 'single'; paintId: string; lastSnapped: Vec2; moved: boolean; dragTargets?: BoardDragTargets | null }
	| { kind: 'group'; lastSnapped: Vec2; moved: boolean; dragTargets?: BoardDragTargets | null }
	| { kind: 'resize'; paintId: string; handle: Exclude<ResizeHandle, 'center'>; original: SelectionResizeBox }
	| {
	kind: 'via'; paintId: string; viaSize: number; fixes: ViaDragFix[];
	lastPreview: { fixes: ViaDragPreviewFix[]; viaPos: Vec2 } | null
}
	| {
	kind: 'track-endpoint'; paintId: string; endpoint: 'start' | 'end'; fixes: ViaDragFix[];
	lastPreview: { fixes: ViaDragPreviewFix[]; dragPoint: Vec2 } | null
}
	| { kind: 'track-body'; line: AssembledTrackLine; dragIndex: number; lastPreview: Vec2[] | null }
	/** Dragging one selected board polygon's CORNER handles. */
	| { kind: 'polygon-point'; paintId: string; index: number }
	/** Dragging one selected board polygon's EDGE-MIDPOINT handles — shifts the
	 *  whole edge sideways in parallel (moveBoardPolygonEdge), never inserts
	 *  a corner (that's the separate "Create Corner" context-menu action).
	 *  `lastSnapped` is this frame's own delta-tracking anchor, exactly like
	 *  the 'single'/'group' footprint-drag gestures below — moveBoardPolygonEdge
	 *  takes a delta, not an absolute position. */
	| { kind: 'polygon-edge'; paintId: string; edgeIndex: number; lastSnapped: Vec2 }
	/** Dragging one of a selected dimension's two MEASURED-point handles —
	 *  re-measures the dimension (see KicadRenderSession.moveDimensionMeasuredPoint). */
	| { kind: 'dimension-point'; paintId: string; index: 0 | 1 }
	/** Dragging one of a selected dimension's two crossbar/arrow-end handles
	 *  — changes the crossbar height (see setDimensionHeightFromCursor).
	 *  The dimension's own TEXT handle needs no dedicated gesture kind — it
	 *  resolves to the text sub-item's own paint id and reuses the ordinary
	 *  'single' drag gesture, which already moves it independently (see
	 *  BoardPainter.buildDimension's doc comment). */
	| { kind: 'dimension-height'; paintId: string }
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
	showTextInput(anchor: Vec2, event: MouseEvent): void;
	showTextBoxInput(first: Vec2, second: Vec2, event: MouseEvent): void;
	tryPlacePendingImage(anchor: Vec2): void;
	openBarcodeDialogForPlacement(anchor: Vec2): void;
	/** A finished zone-outline gesture hands off to the Copper Zone
	 *  Properties dialog instead of committing directly — see the 'zone'
	 *  case in graphicClick's doc comment. */
	openZoneDialogForOutline(points: Vec2[]): void;
	/** Rule areas use the same polygon gesture as zones, then open their
	 * own keepout-properties dialog. */
	openRuleAreaDialogForOutline(points: Vec2[]): void;
	/** A finished plain graphic polygon outline opens its own Polygon
	 *  Properties dialog (layer, fill, line width/style) rather than
	 *  committing directly — see the 'polygon' case in graphicClick. */
	openPolygonDialogForOutline(points: Vec2[]): void;
	getHighlightNetEnabled(): boolean;
	/** `netName` is the net actually being routed (null when starting a
	 *  route on an unassigned/no-net point) — real KiCad sizes a route from
	 *  the routed net's OWN class, not a single board-wide default. */
	getRoutingSizes(netName: string | null): { trackWidth: number; viaSize: number; viaDrill: number };
	/** Real KiCad's "auto track width" toolbar toggle
	 *  (BOARD_DESIGN_SETTINGS::m_UseConnectedTrackWidth) — see
	 *  routeAnchorSnap's connectedWidth capture. */
	getUseConnectedTrackWidth(): boolean;
	/** Real KiCad's "Select Layer Pair" toolbar button — which two copper
	 *  layers a newly placed via spans. */
	getViaLayerPair(): [string, string];
	/** Toolbar "Override locks" checkbox — see onMouseDown's lock checks
	 *  before committing to a drag gesture. */
	getOverrideLocks(): boolean;
	/** Real KiCad's disambiguation popup (GuessSelectionCandidates +
	 *  doSelectionMenu) — see onMouseDown's candidate-count branching. */
	showDisambiguation(
		reduced: HitResult[], all: HitResult[],
		actions: { pick: (candidate: HitResult) => void; selectAll: (candidates: HitResult[]) => void },
		clientX: number, clientY: number
	): void;
	/** The project's net classes/patterns/assignments, for resolving
	 *  per-net-pair clearance (NetClassResolver.resolveClearanceMm) during
	 *  live collision checks. */
	getNetClassRules(): NetClassRules;
	getCornerMode(): '45' | '90' | 'free';
	/** Route → Interactive Router Settings state — see ActiveDocument's
	 *  RouterSettings doc comment for which fields actually change placement
	 *  behavior (mode/allowDrcViolations/removeRedundantTracks) vs. are
	 *  persisted-only for now. */
	getRouterSettings(): RouterSettings;
	dbg(...args: unknown[]): void;
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
	 * Current scope: select + drag board items and footprints (by pad or, now
	 * that BoardPainter has a synthetic whole-body hit item, anywhere on the
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
	protected static readonly graphicStrokeWidth = 0.1;
	/** Snapshot of the board's own copper (pads/tracks/vias) the live route
	 *  preview checks candidate geometry against — rebuilt whenever the
	 *  board's copper actually changes (route start, each committed corner,
	 *  a placed via), not on every mousemove, since panning the mouse alone
	 *  never changes what already exists on the board. null outside an
	 *  active board/route context. */
	protected routerNode: RouterNode | null = null;

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
			else if (command === 'draw-line') this.setTool('line');
			else if (command === 'draw-arc') this.setTool('arc');
			else if (command === 'draw-rectangle') this.setTool('rect');
			else if (command === 'draw-circle') this.setTool('circle');
			else if (command === 'draw-polygon') this.setTool('polygon');
			else if (command === 'draw-zone') this.setTool('zone');
			else if (command === 'draw-rule-area') this.setTool('rule-area');
			else if (command === 'draw-bezier') this.setTool('bezier');
			else if (command === 'place-text') this.setTool('text');
			else if (command === 'draw-text-box') this.setTool('text-box');
			else if (command === 'place-image') this.setTool('image');
			else if (command === 'place-barcode') this.setTool('barcode');
			else if (command === 'dimension-aligned') this.setTool('dimension-aligned');
			else if (command === 'dimension-orthogonal') this.setTool('dimension-orthogonal');
			else if (command === 'select') this.setTool('select');
			else if (command === 'set-grid-origin') this.setTool('grid-origin');
			else if (command === 'set-drill-origin') this.setTool('drill-origin');
			else if (command === 'reset-grid-origin') this.resetOrigin('grid');
			else if (command === 'reset-drill-origin') this.resetOrigin('drill-place');
		});
	}

	setTool(tool: BoardTool): void {
		if (tool !== this.deps.getTool() && (this.isGraphicTool(this.deps.getTool()) || this.deps.getTool() === 'text-box')) {
			this.cancelDrawing();
		}
		if (tool !== 'route') {
			this.cancelRoute();
		}
		if (!this.isGraphicTool(tool) && tool !== 'text-box') {
			this.cancelDrawing();
		}
		this.deps.setTool(tool);
		this.deps.setStatus(tool === 'route'
			? `Route tracks on ${ this.deps.getActiveLayer() } — click to start and add corners; Enter/double-click finishes.`
			: tool === 'via' ? 'Place vias — click copper to inherit its net.'
				: tool === 'line' ? `Draw Line on ${ this.deps.getActiveLayer() } — click start and end.`
					: tool === 'arc' ? `Draw Arc on ${ this.deps.getActiveLayer() } — click start, end, then the arc mid-point.`
						: tool === 'rect' ? `Draw Rectangle on ${ this.deps.getActiveLayer() } — click opposite corners.`
							: tool === 'circle' ? `Draw Circle on ${ this.deps.getActiveLayer() } — click center then radius.`
								: tool === 'polygon' ? `Draw Polygon on ${ this.deps.getActiveLayer() } — click vertices; click the first point, press Enter, or right-click to finish.`
									: tool === 'bezier' ? `Draw Bezier on ${ this.deps.getActiveLayer() } — click start, two control points, then end.`
											: tool === 'zone' ? 'Draw Zone — click vertices; click the first point, press Enter, or right-click to finish and open Zone Properties.'
											: tool === 'rule-area' ? 'Draw Rule Area — click vertices; click the first point, press Enter, or right-click to finish and open Rule Area Properties.'
												: tool === 'dimension-aligned' ? `Add Aligned Dimension on ${ this.deps.getActiveLayer() } — click two measured points, then the dimension-line position.`
													: tool === 'dimension-orthogonal' ? `Add Orthogonal Dimension on ${ this.deps.getActiveLayer() } — click two measured points, then the dimension-line position.`
										: tool === 'text' ? `Place Text on ${ this.deps.getActiveLayer() } — click to enter text.`
											: tool === 'text-box' ? `Draw Text Box on ${ this.deps.getActiveLayer() } — click opposite corners, then enter text.`
											: tool === 'image' ? `Place Image on ${ this.deps.getActiveLayer() } — click to insert the selected image.`
												: tool === 'barcode' ? `Place Barcode on ${ this.deps.getActiveLayer() } — click to set its position and properties.`
				: tool === 'grid-origin' ? 'Set Grid Origin — click a grid point.'
					: tool === 'drill-origin' ? 'Set Drill/Place File Origin — click a grid point.' : 'PCB select tool active.');
	}

	finishRoute(): boolean {
		if (this.pending.current.kind !== 'route') {
			return false;
		}
		this.pending.clear();
		this.deps.getSession()?.getRouteTool().Cancel();
		this.deps.getSession()?.setEditPreview(null);
		this.deps.setStatus('Route finished.');
		return true;
	}

	cancelRoute(): boolean {
		if (this.pending.current.kind !== 'route') {
			return false;
		}
		this.pending.clear();
		this.deps.getSession()?.getRouteTool().Cancel();
		this.deps.getSession()?.setEditPreview(null);
		this.deps.setStatus('Route cancelled.');
		return true;
	}

	finishDrawing(): boolean {
		const session = this.deps.getSession();
		const pending = this.pending.current;
		if (!session || (pending.kind !== 'polygon' && pending.kind !== 'zone' && pending.kind !== 'rule-area') || pending.points.length < 3) {
			return false;
		}
		if (pending.kind === 'zone') {
			this.pending.clear();
			session.setEditPreview(null);
			this.deps.openZoneDialogForOutline(pending.points);
			return true;
		}
		if (pending.kind === 'rule-area') {
			this.pending.clear();
			session.setEditPreview(null);
			this.deps.openRuleAreaDialogForOutline(pending.points);
			return true;
		}
		this.pending.clear();
		session.setEditPreview(null);
		this.deps.openPolygonDialogForOutline(pending.points);
		return true;
	}

	cancelDrawing(): boolean {
		const pending = this.pending.current;
		if (!this.isGraphicPending(pending)) {
			return false;
		}
		this.pending.clear();
		this.deps.getSession()?.setEditPreview(null);
		this.deps.setStatus('Drawing cancelled.');
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
		// Pcbnew completes a graphic polygon (or, here, a zone outline) with a
		// right click.  This needs to precede board navigation, which
		// otherwise treats every right click as the start of a pan gesture.
		if (this.deps.getMode() === 'edit' && (this.deps.getTool() === 'polygon' || this.deps.getTool() === 'zone' || this.deps.getTool() === 'rule-area')
			&& e.button === 2 && (this.pending.current.kind === 'polygon' || this.pending.current.kind === 'zone' || this.pending.current.kind === 'rule-area')) {
			if (this.finishDrawing()) {
				this.suppressNextContextMenu = true;
				e.preventDefault();
				return;
			}
			const noun = this.deps.getTool() === 'zone' ? 'zone' : this.deps.getTool() === 'rule-area' ? 'rule area' : 'polygon';
			this.deps.setStatus(`A ${ noun } needs at least three vertices before it can be finished.`);
			this.suppressNextContextMenu = true;
			e.preventDefault();
			return;
		}
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
		if (this.deps.getTool() === 'select') {
			const dimHandle = this.dimensionAnchorAtScreen(session, screenPos);
			if (dimHandle) {
				if (dimHandle.kind === 'measured') {
					session.pushUndoSnapshot('Edit dimension');
					this.gesture = { kind: 'dimension-point', paintId: dimHandle.paintId, index: dimHandle.index };
				}
				else if (dimHandle.kind === 'crossbar') {
					session.pushUndoSnapshot('Edit dimension');
					this.gesture = { kind: 'dimension-height', paintId: dimHandle.paintId };
				}
				else {
					// The text handle reuses the ordinary single-item drag —
					// its paint id is the text sub-item's own, which
					// translateElementGeometry already moves independently
					// (see BoardPainter.buildDimension's doc comment).
					const textPaintId = dimHandle.paintId.replace(/:(line|text)$/, ':text');
					session.pushUndoSnapshot('Move dimension text');
					this.gesture = { kind: 'single', paintId: textPaintId, lastSnapped: this.snappedWorld(session, screenPos), moved: false };
				}
				e.preventDefault();
				return;
			}
			const handle = this.polygonOutlineAnchorAtScreen(session, screenPos);
			if (handle) {
				if ('corner' in handle) {
					session.pushUndoSnapshot('Edit polygon outline');
					this.gesture = { kind: 'polygon-point', paintId: handle.paintId, index: handle.corner };
				}
				else {
					session.pushUndoSnapshot('Edit polygon outline');
					this.gesture = {
						kind: 'polygon-edge', paintId: handle.paintId, edgeIndex: handle.edge,
						lastSnapped: this.snappedWorld(session, screenPos)
					};
				}
				e.preventDefault();
				return;
			}
			const resizeHandle = this.resizeHandleAtScreen(session, screenPos);
			if (resizeHandle) {
				if (session.isBoardElementLocked(resizeHandle.box.id) && !this.deps.getOverrideLocks()) {
					this.deps.setStatus('Item locked — enable "Override locks" to resize it.');
					e.preventDefault();
					return;
				}
				session.pushUndoSnapshot('Resize item');
				this.gesture = resizeHandle.handle === 'center'
					? { kind: 'single', paintId: resizeHandle.box.id, lastSnapped: this.snappedWorld(session, screenPos), moved: false }
					: {
						kind: 'resize', paintId: resizeHandle.box.id,
						handle: resizeHandle.handle, original: resizeHandle.box
					};
				e.preventDefault();
				return;
			}
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
		if (this.deps.getTool() === 'text') {
			this.deps.showTextInput(this.snappedWorld(session, screenPos), e);
			e.preventDefault();
			return;
		}
		if (this.deps.getTool() === 'text-box') {
			this.textBoxClick(session, screenPos, e);
			e.preventDefault();
			return;
		}
		if (this.deps.getTool() === 'image') {
			this.deps.tryPlacePendingImage(this.snappedWorld(session, screenPos));
			e.preventDefault();
			return;
		}
		if (this.isGraphicTool(this.deps.getTool())) {
			this.graphicClick(session, screenPos, e.detail >= 2);
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
		this.dragUndoCaptured = false;
		const { reduced, all } = session.hitTestCandidatesAtScreen(screenPos, this.deps.getActiveLayer());
		if (reduced.length === 0) {
			// Empty-space mousedown begins a rect-select gesture — onMouseUp
			// decides whether it was a real drag (marquee-select) or a plain
			// click (clear selection), matching PointerController's identical
			// rect-select convention.
			this.gesture = { kind: 'rect', originWorld: session.screenToWorld(screenPos), originScreen: screenPos, moved: false };
			return;
		}
		if (reduced.length === 1) {
			this.resolveHit(session, reduced[0]!, screenPos, true, e);
			return;
		}
		// If one of the ambiguous candidates is already selected, use it
		// directly instead of disambiguating — mirrors real KiCad's own
		// drag-start check (pcb_selection_tool.cpp's Main() IsDrag handler:
		// "Check if dragging has started within any of selected items
		// bounding box" -> doDrag = true WITHOUT calling selectPoint/
		// disambiguation again). Without this, clicking on an
		// already-selected wire that also happens to overlap something else
		// (a pad, another track) would re-disambiguate on every single
		// press, making it impossible to ever start dragging it.
		const alreadySelected = reduced.find(candidate => session.selectionIds.has(candidate.id));
		if (alreadySelected) {
			this.resolveHit(session, alreadySelected, screenPos, true, e);
			return;
		}
		// Genuinely ambiguous — real KiCad's own disambiguation popup
		// (pcb_selection_tool.cpp GuessSelectionCandidates/doSelectionMenu).
		// The mouse button is already back up by the time the user picks a
		// row, so resolved picks never arm a drag gesture (allowGesture:
		// false) — a deliberate, called-out simplification vs. real KiCad,
		// which lets you disambiguate mid-drag.
		e.preventDefault();
		// Stops THIS mousedown from reaching ContextMenu's own window-level
		// 'mousedown' listener (see its outsideClickArmed doc comment) -
		// without this, the popup show() call below would close itself
		// before the user could pick a row, since the same event is still
		// bubbling toward window at this point.
		e.stopPropagation();
		this.deps.showDisambiguation(reduced, all, {
			pick: candidate => this.resolveHit(session, candidate, screenPos, false),
			selectAll: candidates => {
				session.selectMultiple(candidates.map(candidate => candidate.id), 'replace');
				this.deps.refreshAppearance();
			}
		}, e.clientX, e.clientY);
	}

	/** The single-candidate tail of onMouseDown's hit-and-select flow —
	 *  also the disambiguation popup's pick/Select-All target. `allowGesture`
	 *  is false for a disambiguated pick (resolved well after the triggering
	 *  mousedown's button is back up, so there's no live drag to arm) — the
	 *  item still gets selected and lock-refused exactly as normal, it just
	 *  never becomes a drag gesture or starts a drag preview. `e` is the
	 *  live mousedown event for the direct (allowGesture: true) path only;
	 *  omitted for a disambiguated pick, which isn't itself a DOM event. */
	protected resolveHit(session: KicadRenderSession, hit: HitResult, screenPos: Vec2, allowGesture: boolean, e?: MouseEvent): void {
		if (hit.kind === 'via') {
			session.select(hit.id);
			this.deps.refreshAppearance();
			if (session.isBoardElementLocked(hit.id) && !this.deps.getOverrideLocks()) {
				this.deps.setStatus('Item locked — enable "Override locks" to move it.');
				this.gesture = { kind: 'none' };
				e?.preventDefault();
				return;
			}
			if (allowGesture) {
				// Computed once, up front — see viaDragFanout's doc comment for
				// why re-deriving this every mousemove (the original approach)
				// caused the reported "trail of stray segments" mess.
				const fanout = session.viaDragFanout(hit.id);
				this.gesture = fanout
					? { kind: 'via', paintId: hit.id, viaSize: fanout.viaSize, fixes: fanout.fixes, lastPreview: null }
					: { kind: 'none' };
			}
			else {
				this.gesture = { kind: 'none' };
			}
			e?.preventDefault();
			return;
		}
		if (hit.kind === 'track') {
			session.select(hit.id);
			this.deps.refreshAppearance();
			const endpoint = allowGesture ? session.trackEndpointNear(hit.id, screenPos) : null;
			if (endpoint && session.isBoardElementLocked(hit.id) && !this.deps.getOverrideLocks()) {
				this.deps.setStatus('Item locked — enable "Override locks" to move it.');
				this.gesture = { kind: 'none' };
				e?.preventDefault();
				return;
			}
			// A click that landed mid-track (not near either endpoint) starts a
			// real KiCad-style body drag: the WHOLE connected line reflows, not
			// just the one segment clicked — see assembleTrackLine's doc
			// comment. Locked check covers every segment in the assembled
			// line, not just the clicked one.
			if (!endpoint && allowGesture) {
				const line = session.assembleTrackLine(hit.id);
				if (line) {
					if (line.segmentIds.some(id => session.isBoardElementLocked(id)) && !this.deps.getOverrideLocks()) {
						this.deps.setStatus('Item locked — enable "Override locks" to move it.');
						this.gesture = { kind: 'none' };
						e?.preventDefault();
						return;
					}
					const dragIndex = line.segmentIds.indexOf(hit.id);
					this.gesture = { kind: 'track-body', line, dragIndex, lastPreview: null };
					// beginTrackDragPreview (hiding the assembled line's own
					// segments for the live-preview overlay's sake) is deferred
					// to onMouseMove's first real frame, NOT called here — a
					// plain click with no movement never reaches onMouseMove at
					// all, so hiding right away made every click on a track
					// blink it invisible for the whole mousedown-to-mouseup
					// span, even when the user never dragged anything.
					e?.preventDefault();
					return;
				}
			}
			if (endpoint) {
				// Computed once, up front — same reasoning as viaDragFanout's
				// own doc comment: re-deriving this every mousemove would let
				// the anchor slide forward onto the previous frame's own
				// throwaway corner instead of staying at the line's real far
				// point.
				const fanout = session.trackCornerDragFanout(hit.id, endpoint);
				this.gesture = fanout
					? { kind: 'track-endpoint', paintId: hit.id, endpoint, fixes: fanout.fixes, lastPreview: null }
					: { kind: 'none' };
			}
			else {
				this.gesture = { kind: 'none' };
			}
			e?.preventDefault();
			return;
		}
		if (hit.kind !== 'pad' && hit.kind !== 'footprint') {
			session.select(hit.id);
			this.deps.refreshAppearance();
			if (session.isBoardElementLocked(hit.id) && !this.deps.getOverrideLocks()) {
				this.deps.setStatus('Item locked — enable "Override locks" to move it.');
				this.gesture = { kind: 'none' };
			}
			else {
				this.gesture = allowGesture
					? { kind: 'single', paintId: hit.id, lastSnapped: this.snappedWorld(session, screenPos), moved: false }
					: { kind: 'none' };
			}
			e?.preventDefault();
			return;
		}
		// Normalize a pad hit to its owning footprint's own id — selectedIds
		// (populated from rect-select's footprint-level results) never
		// contains a raw pad id, so checking membership with the un-
		// normalized hit.id would never find a match and group-drag could
		// never trigger.
		const footprintId = session.footprintPaintIdForHit(hit.id);
		if (allowGesture && session.selectionIds.size > 1 && session.selectionIds.has(footprintId)) {
			// Simplified scope vs. real KiCad's per-item exclusion: refuse the
			// whole group drag if ANY selected item is locked, rather than
			// silently dragging everything else around it.
			if (!this.deps.getOverrideLocks() && [...session.selectionIds].some(id => session.isBoardElementLocked(id))) {
				this.deps.setStatus('Locked item(s) in selection — enable "Override locks" to move them.');
				e?.preventDefault();
				return;
			}
			// beginBoardDragPreview (KicadRenderSession.ts) — which pulls every
			// selected footprint out of the real static-buffer scene — is
			// deferred to onMouseMove's first actual displacement (see
			// BoardGesture's own doc comment on `moved`), not run here: a
			// plain click that never moves would otherwise still pay that
			// full static-geometry rebuild for nothing.
			this.gesture = { kind: 'group', lastSnapped: this.snappedWorld(session, screenPos), moved: false };
			e?.preventDefault();
			return;
		}
		session.select(footprintId);
		this.deps.refreshAppearance();
		if (session.isBoardElementLocked(footprintId) && !this.deps.getOverrideLocks()) {
			this.deps.setStatus('Item locked — enable "Override locks" to move it.');
			this.gesture = { kind: 'none' };
			e?.preventDefault();
			return;
		}
		// beginBoardDragPreview deferred to the first real mousemove
		// displacement, same reasoning as the 'group' branch above.
		this.gesture = allowGesture
			? { kind: 'single', paintId: footprintId, lastSnapped: this.snappedWorld(session, screenPos), moved: false }
			: { kind: 'none' };
		e?.preventDefault();
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
			session.setBoardWorkingPoint(this.computeWorkingPoint(session, screenPos));
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
		if (session.documentTypeLoaded === 'board' && this.isGraphicTool(this.deps.getTool())) {
			this.updateGraphicPreview(session, screenPos);
		}
		if (session.documentTypeLoaded === 'board' && this.deps.getTool() === 'text-box') {
			this.updateTextBoxPreview(session, screenPos);
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
				const paintId = this.gesture.paintId;
				// Resolved lazily, once, on this gesture's first real move —
				// see BoardDragTargets/BoardGesture's own doc comments.
				let dragTargets = this.gesture.dragTargets;
				if (dragTargets === undefined) {
					dragTargets = session.resolveBoardDragTargets([paintId]);
				}
				// Snapshot BEFORE mutating — captureUndoOnce only pushes once
				// per gesture (on the first real move), so this must run
				// before translateBoardDragFast actually moves anything, or
				// the "undo" target ends up being this frame's post-move
				// state instead of the drag's true starting position.
				this.captureUndoOnce(session, 'Move item');
				session.beginBoardDragPerformance();
				const usedFastPath = !!dragTargets && session.translateBoardDragFast(dragTargets, dx, dy);
				console.info('translateBoardDragFast used (single):', usedFastPath);
				session.noteBoardDragFrame(usedFastPath);
				if (usedFastPath) {
					try {
						const movedIds = dragTargets?.itemIds ?? [];
						// Track cumulative drag delta on the targets so previews can be
						// positioned correctly even though session.scene isn't mutated
						// by the fast GPU translate path.
						if (dragTargets) {
							if (typeof (dragTargets as any)._accumDx !== 'number') {
								(dragTargets as any)._accumDx = 0;
								(dragTargets as any)._accumDy = 0;
							}
							(dragTargets as any)._accumDx += dx;
							(dragTargets as any)._accumDy += dy;
						}
						const netIds = new Set<number>();
						const sceneAny = (session as any).scene;
						if (sceneAny) {
							for (const item of sceneAny.hitTestItems) {
								if (item.kind !== 'pad' || item.netId == null) continue;
								const ownerId = (item.id || '').split(':')[0];
								if (movedIds.includes(ownerId) || movedIds.includes(item.id)) {
									netIds.add(item.netId);
								}
							}
						}
let previewLines = session.computePreviewRatsnest(netIds);
						// Adjust endpoints that snap to pads belonging to the moved
						// footprints by the accumulated drag delta so the preview lines
						// visually follow the fast-path translation.
						try {
							if (sceneAny && previewLines.length > 0) {
								const padCenters = new Map<string, { x: number; y: number }>();
								for (const item of sceneAny.hitTestItems) {
									if (item.kind !== 'pad' || item.netId == null) continue;
									const ownerId = (item.id || '').split(':')[0];
									if (!movedIds.includes(ownerId) && !movedIds.includes(item.id)) continue;
									padCenters.set(item.id, { x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 });
								}
								const EPS = 1e-4;
								const accumDx = (dragTargets as any)?._accumDx ?? 0;
								const accumDy = (dragTargets as any)?._accumDy ?? 0;
								for (const line of previewLines) {
									for (const [padId, center] of padCenters) {
										if (Math.hypot(line.from.x - center.x, line.from.y - center.y) <= EPS) {
											line.from = new Vec2(center.x + accumDx, center.y + accumDy);
										}
										if (Math.hypot(line.to.x - center.x, line.to.y - center.y) <= EPS) {
											line.to = new Vec2(center.x + accumDx, center.y + accumDy);
										}
									}
								}
							}
						} catch (e) {
							console.info('fast-path preview snap adjust failed', e);
						}
session.setPreviewRatsnest(previewLines, netIds);
						session.scheduleRender();
					}
					catch (err) {
						console.info('fast-path preview build failed (single)', err);
					}
				}
				if (!usedFastPath) {
					// Either resolveBoardDragTargets found nothing it can
					// fast-path (a bare track/graphic/dimension-text paintId),
					// or translateBoardDragFast itself declined — cache `null`
					// either way so the rest of this gesture doesn't keep
					// re-attempting it every frame.
					dragTargets = null;
					if (!this.gesture.moved) {
						// First real displacement of this gesture — only now
						// pull any footprint out of the static WebGL buffer (a
						// no-op for a non-footprint paintId — see
						// footprintOwnerOfHit). Matches the 'via'/'track-body'
						// gestures' own identical "defer past a plain click"
						// pattern elsewhere in this file — see BoardGesture's
						// doc comment on `moved`.
						session.beginBoardDragPreview([paintId]);
					}
					// captureUndoOnce already ran above, before the fast-path
					// attempt — gated by dragUndoCaptured, so it's a no-op here.
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
					const moved = session.translateBoardSelection([paintId], dx, dy);
					if (moved) {
						// See the 'group' branch below — no per-frame text
						// refresh during the drag.
						session.updateBoardDragPreview();
					}
				}
				this.gesture = { kind: 'single', paintId, lastSnapped: snapped, moved: true, dragTargets };
			}
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'resize') {
			const snapped = this.snappedWorld(session, screenPos);
			const bounds = this.resizedBoundsFromHandle(this.gesture.original, this.gesture.handle, snapped);
			session.resizeBoardElementBoundsById(
				this.gesture.paintId, bounds.x, bounds.y, bounds.width, bounds.height, this.gesture.handle);
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'polygon-point') {
			const snapped = this.snappedWorld(session, screenPos);
			session.moveBoardPolygonPoint(this.gesture.paintId, this.gesture.index, snapped.x, snapped.y);
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'dimension-point') {
			// Object-anchor-snapped, matching real KiCad's own dimension tool
			// (same snap the initial placement clicks already use — see
			// dimensionAnchorSnap's own doc comment) — re-measuring a
			// dimension by dragging its endpoint onto a pad/graphic corner is
			// exactly the "snaps" behavior being replicated here.
			const snapped = this.dimensionAnchorSnap(session, screenPos);
			session.moveDimensionMeasuredPoint(this.gesture.paintId, this.gesture.index, snapped.x, snapped.y);
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'dimension-height') {
			const snapped = this.snappedWorld(session, screenPos);
			session.setDimensionHeightFromCursor(this.gesture.paintId, snapped.x, snapped.y);
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'polygon-edge') {
			const snapped = this.snappedWorld(session, screenPos);
			const dx = snapped.x - this.gesture.lastSnapped.x;
			const dy = snapped.y - this.gesture.lastSnapped.y;
			if (dx !== 0 || dy !== 0) {
				session.moveBoardPolygonEdge(this.gesture.paintId, this.gesture.edgeIndex, dx, dy);
				this.gesture = { kind: 'polygon-edge', paintId: this.gesture.paintId, edgeIndex: this.gesture.edgeIndex, lastSnapped: snapped };
			}
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'group') {
			const snapped = this.snappedWorld(session, screenPos);
			const dx = snapped.x - this.gesture.lastSnapped.x;
			const dy = snapped.y - this.gesture.lastSnapped.y;
			if (dx !== 0 || dy !== 0) {
				// See the 'single' branch above for the full reasoning — same
				// lazy-resolve-once-then-cache pattern.
				let dragTargets = this.gesture.dragTargets;
				if (dragTargets === undefined) {
					dragTargets = session.resolveBoardDragTargets([...session.selectionIds]);
				}
				// Snapshot BEFORE mutating — see the 'single' branch above for
				// why this must precede the fast-path attempt, not follow it.
				this.captureUndoOnce(session, 'Move footprints');
				session.beginBoardDragPerformance();
				const usedFastPath = !!dragTargets && session.translateBoardDragFast(dragTargets, dx, dy);
				console.info('translateBoardDragFast used (group):', usedFastPath, 'selectionSize=', session.selectionIds?.size ?? 0);
				session.noteBoardDragFrame(usedFastPath);
				if (usedFastPath) {
					try {
						const movedIds = dragTargets?.itemIds ?? [];
						// Track cumulative drag delta so the preview can be snapped to
						// moving pad centers even when the WebGL fast-path translates
						// visuals without mutating session.scene.
						if (dragTargets) {
							if (typeof (dragTargets as any)._accumDx !== 'number') {
								(dragTargets as any)._accumDx = 0;
								(dragTargets as any)._accumDy = 0;
							}
							(dragTargets as any)._accumDx += dx;
							(dragTargets as any)._accumDy += dy;
						}
						const netIds = new Set<number>();
						const sceneAny = (session as any).scene;
						if (sceneAny) {
							for (const item of sceneAny.hitTestItems) {
								if (item.kind !== 'pad' || item.netId == null) continue;
								const ownerId = (item.id || '').split(':')[0];
								if (movedIds.includes(ownerId) || movedIds.includes(item.id)) {
									netIds.add(item.netId);
								}
							}
						}
let previewLines = session.computePreviewRatsnest(netIds);
						try {
							if (sceneAny && previewLines.length > 0) {
								const padCenters = new Map<string, { x: number; y: number }>();
								for (const item of sceneAny.hitTestItems) {
									if (item.kind !== 'pad' || item.netId == null) continue;
									const ownerId = (item.id || '').split(':')[0];
									if (!movedIds.includes(ownerId) && !movedIds.includes(item.id)) continue;
									padCenters.set(item.id, { x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 });
								}
								const EPS = 1e-4;
								const accumDx = (dragTargets as any)?._accumDx ?? 0;
								const accumDy = (dragTargets as any)?._accumDy ?? 0;
								for (const line of previewLines) {
									for (const [padId, center] of padCenters) {
										if (Math.hypot(line.from.x - center.x, line.from.y - center.y) <= EPS) {
											line.from = new Vec2(center.x + accumDx, center.y + accumDy);
										}
										if (Math.hypot(line.to.x - center.x, line.to.y - center.y) <= EPS) {
											line.to = new Vec2(center.x + accumDx, center.y + accumDy);
										}
									}
								}
							}
						} catch (e) {
							console.info('fast-path preview snap adjust failed', e);
						}
session.setPreviewRatsnest(previewLines, netIds);
						session.scheduleRender();
					}
					catch (err) {
						console.info('fast-path preview build failed (group)', err);
					}
				}
				if (!usedFastPath) {
					dragTargets = null;
					if (!this.gesture.moved) {
						// See the 'single' branch above — deferred past a plain
						// click, same reasoning.
						session.beginBoardDragPreview(session.selectionIds);
					}
					// captureUndoOnce already ran above, before the fast-path
					// attempt — gated by dragUndoCaptured, so it's a no-op here.
					const moved = session.translateBoardSelection([...session.selectionIds], dx, dy);
					if (moved) {
						// See the 'single' branch above — no per-frame text refresh
						// during the drag.
						session.updateBoardDragPreview();
					}
				}
				this.gesture = { kind: 'group', lastSnapped: snapped, moved: true, dragTargets };
			}
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'via') {
			const { paintId, viaSize, fixes } = this.gesture;
			if (!this.gesture.lastPreview) {
				// First real move of the gesture — only now hide the fanout's
				// original near-via segments, matching track-body drag's
				// identical "defer the hide past a plain click" reasoning (see
				// beginTrackDragPreview's doc comment).
				session.beginTrackDragPreview([paintId, ...fixes.flatMap(f => f.segmentIds)]);
			}
			const target = this.snappedWorld(session, screenPos);
			const cornerMode = this.deps.getCornerMode() === '90' ? '90' : '45';
			const previewFixes: ViaDragPreviewFix[] = fixes.map(fix => ({
				...fix,
				chain: mergeCollinear(dragViaChain(fix.originPoints, target, cornerMode))
			}));
			this.gesture = { ...this.gesture, lastPreview: { fixes: previewFixes, viaPos: target } };
			session.setEditPreview({
				kind: 'via-drag',
				tracks: previewFixes.map(fix => ({ points: fix.chain.slice(0, -1), width: fix.width })),
				cursor: target,
				viaSize
			});
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'track-endpoint') {
			const { fixes } = this.gesture;
			if (!this.gesture.lastPreview) {
				// First real move — only now hide every fanout line's whole
				// segment chain (see beginTrackDragPreview's doc comment; same
				// "defer past a plain click" reasoning as via-drag/track-body).
				session.beginTrackDragPreview(fixes.flatMap(f => f.segmentIds));
			}
			// Reuses the route tool's own magnetic-anchor snap (routeAnchorSnap)
			// so dragging a dangling end onto a same-net pad/via/other track
			// endpoint reconnects exactly onto it, the same "lands on the exact
			// center, not wherever the cursor happened to be" behavior real
			// KiCad's DRAGGER gets for free by sharing GRID_HELPER with the
			// router — grid-snap otherwise, same as before this existed.
			const netFilter = fixes[0]?.netId ?? null;
			const target = this.routeAnchorSnap(session, screenPos, netFilter).point;
			const cornerMode = this.deps.getCornerMode() === '90' ? '90' : '45';
			const previewFixes: ViaDragPreviewFix[] = fixes.map(fix => ({
				...fix,
				chain: mergeCollinear(dragViaChain(fix.originPoints, target, cornerMode))
			}));
			this.gesture = { ...this.gesture, lastPreview: { fixes: previewFixes, dragPoint: target } };
			session.setEditPreview({
				kind: 'via-drag',
				tracks: previewFixes.map(fix => ({ points: fix.chain.slice(0, -1), width: fix.width })),
				cursor: target
			});
			this.deps.updateStatusBar(screenPos);
			return;
		}
		if (this.gesture.kind === 'track-body') {
			const { line, dragIndex } = this.gesture;
			if (!this.gesture.lastPreview) {
				// First real move of the gesture — only now hide the assembled
				// line's own segments (see beginTrackDragPreview's doc comment).
				// Deferred from onMouseDown so a plain click that never moves
				// never hides anything at all.
				session.beginTrackDragPreview(line.segmentIds);
			}
			const target = this.snappedWorld(session, screenPos);
			const cornerMode = this.deps.getCornerMode() === '90' ? '90' : '45';
			// Drive the canonical drag tool (wraps dragSegment45 + mergeCollinear
			// behind a state machine) instead of calling the primitive directly.
			const dragTool = session.getDragTool();
			dragTool.Select(line.points, dragIndex, 'segment');
			dragTool.SetCornerMode(cornerMode);
			dragTool.SetWidth(line.width);
			const dragged = dragTool.Move(target).path;
			const settings = this.deps.getRouterSettings();
			const clearanceFn = this.clearanceResolver(session);
			const rawCollides = this.pathCollides(dragged, line.width, line.layer, line.netId, clearanceFn);
			// Shove/walkaround never mutate during the live preview — matches
			// updateRoutePreview's identical "dry run, don't flash red for
			// something about to be resolved on commit" reasoning.
			let previewPoints = dragged;
			let previewCollides = rawCollides;
			if (rawCollides && settings.mode === 'shove') {
				previewCollides = this.planShoveForPath(session, dragged, line.layer, line.netId, line.width) === null;
			}
			else if (rawCollides && settings.mode === 'walkaround') {
				const walked = this.walkAroundObstacles(
					session, dragged[0]!, dragged[dragged.length - 1]!, dragged,
					{ layer: line.layer, netId: line.netId }, line.width);
				if (walked) {
					previewPoints = walked;
					previewCollides = false;
				}
			}
			this.gesture = { ...this.gesture, lastPreview: previewPoints };
			session.setEditPreview({
				kind: 'route',
				points: previewPoints.slice(0, -1),
				cursor: previewPoints[previewPoints.length - 1]!,
				width: line.width,
				collides: previewCollides
			});
			if (previewCollides) {
				this.deps.setStatus(settings.allowDrcViolations
					? `Dragging track on ${ line.layer } — clearance violation, still placeable (DRC violations allowed).`
					: `Dragging track on ${ line.layer } — clearance violation, can't place here.`);
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
			// see KicadRenderSession.endBoardDragPreview's doc comment.
			// Unconditional (not gated on gesture.moved) but cheap for a
			// plain click: beginBoardDragPreview is only ever called lazily
			// on the first real mousemove displacement now (see BoardGesture's
			// doc comment on `moved`), so for a click that never moved,
			// dragPreviewFootprints stayed empty and endBoardDragPreview's own
			// early-return guard makes this a genuine no-op — nothing was
			// ever pulled out of the static scene to bake back in. No
			// separate ratsnest resync needed here: every mousemove during an
			// actual drag already kept it correct (endBoardDragPreview itself
			// does one last net-scoped incremental refresh).
			const session = this.deps.getSession();
			if (gesture.dragTargets) {
				// The fast path was used for this whole gesture — the GPU
				// buffer is already exactly right (translateBoardDragFast kept
				// it in sync every frame), this only catches up the CPU-side
				// scene/hit-test data. beginBoardDragPreview was never called
				// (dragPreviewFootprints stayed empty), so endBoardDragPreview
				// below is still safe to call unconditionally — it just no-ops.
				session?.commitBoardDragFast(gesture.dragTargets);
			}
			// Bakes the drag-preview footprint(s) back into the real scene —
			// see KicadRenderSession.endBoardDragPreview's doc comment.
			// Unconditional (not gated on gesture.moved) but cheap for a
			// plain click: beginBoardDragPreview is only ever called lazily
			// on the first real mousemove displacement now (see BoardGesture's
			// doc comment on `moved`), so for a click that never moved,
			// dragPreviewFootprints stayed empty and endBoardDragPreview's own
			// early-return guard makes this a genuine no-op — nothing was
			// ever pulled out of the static scene to bake back in. No
			// separate ratsnest resync needed here: every mousemove during an
			// actual drag already kept it correct (endBoardDragPreview itself
			// does one last net-scoped incremental refresh).
			session?.endBoardDragPreview();
			// The one text-refresh (full AST serialize + save/sync) for this
			// whole gesture — see onMouseMove's 'single'/'group' branches for
			// why it's not called per-frame anymore. wasDragging (captured
			// before dragUndoCaptured was reset above) is true only once an
			// actual move happened, matching captureUndoOnce's own gate.
			if (session && wasDragging) {
				this.deps.refreshBoardText(session);
			}
			session?.endBoardDragPerformance();
			return;
		}
		if (gesture.kind === 'resize') {
			const session = this.deps.getSession();
			if (session) {
				this.deps.refreshBoardText(session);
				this.deps.refreshAppearance();
				this.deps.setStatus('Item resized.');
			}
			return;
		}
		if (gesture.kind === 'dimension-point' || gesture.kind === 'dimension-height') {
			const session = this.deps.getSession();
			if (session) {
				this.deps.refreshBoardText(session);
				this.deps.refreshAppearance();
				this.deps.setStatus(gesture.kind === 'dimension-point' ? 'Dimension re-measured.' : 'Dimension crossbar height changed.');
			}
			return;
		}
		if (gesture.kind === 'polygon-point' || gesture.kind === 'polygon-edge') {
			const session = this.deps.getSession();
			if (session) {
				this.deps.refreshBoardText(session);
				this.deps.refreshAppearance();
				this.deps.setStatus('Polygon outline edited.');
				const isZone = (session.activeScene?.hitTestItems ?? []).some(item => item.kind === 'zone'
					&& (item.id === gesture.paintId || item.id.startsWith(`${ gesture.paintId }:`)));
				if (!isZone) {
					return;
				}
				// Re-fills every zone (not just this one — matches the Copper
				// Zone Properties dialog's own commit path) via the same
				// progress-modal-backed handler MainApp already wires up for
				// 'fill-all-zones', so an edited outline's copper pour stays in
				// sync with its new shape without duplicating that plumbing here.
				window.dispatchEvent(new CustomEvent<string>('kionline:board-command', { detail: 'fill-all-zones' }));
			}
			return;
		}
		if (gesture.kind === 'track-endpoint') {
			const session = this.deps.getSession();
			session?.setEditPreview(null);
			// Unconditional, like via-drag/track-body's own identical contract
			// — the hide from beginTrackDragPreview must come back whether
			// this drag commits, gets refused, or never moved at all.
			session?.endTrackDragPreview();
			if (!session || !gesture.lastPreview) {
				// Never moved (a plain click on a track endpoint) — nothing to commit.
				return;
			}
			const committed = session.commitTrackCornerDrag(gesture.lastPreview.fixes);
			if (committed) {
				this.deps.refreshBoardText(session);
				this.deps.refreshAppearance();
				this.deps.setStatus('Track dragged.');
			}
			return;
		}
		if (gesture.kind === 'via') {
			const session = this.deps.getSession();
			session?.setEditPreview(null);
			// Unconditional, like track-body drag's own identical contract —
			// the hide from beginTrackDragPreview must come back whether this
			// drag commits, gets refused, or never moved at all.
			session?.endTrackDragPreview();
			if (!session || !gesture.lastPreview) {
				// Never moved (a plain click on a via) — nothing to commit.
				return;
			}
			const { fixes, viaPos } = gesture.lastPreview;
			const committed = session.commitViaDrag(gesture.paintId, fixes, viaPos.x, viaPos.y);
			if (committed) {
				this.deps.refreshBoardText(session);
				this.deps.refreshAppearance();
				this.deps.setStatus('Via dragged.');
			}
			return;
		}
		if (gesture.kind === 'track-body') {
			const session = this.deps.getSession();
			session?.setEditPreview(null);
			if (!session || !gesture.lastPreview) {
				// Never moved (a plain click on a track body) — nothing to commit.
				session?.endTrackDragPreview();
				return;
			}
			const { line } = gesture;
			const clearanceFn = this.clearanceResolver(session);
			// Recheck against the FINAL preview rather than trusting whatever
			// collides flag the last onMouseMove frame computed — cheap, and
			// guards against acting on a stale value if settings changed
			// mid-drag (e.g. toggling "Allow DRC violations").
			const collides = this.pathCollides(gesture.lastPreview, line.width, line.layer, line.netId, clearanceFn);
			const settings = this.deps.getRouterSettings();
			if (collides && !settings.allowDrcViolations) {
				// Matches real KiCad refusing to fix a colliding drag — leaves
				// the track at its pre-drag shape (see commitRouteTo's
				// identical "stay put" behavior on a blocked commit).
				this.deps.setStatus(`Can't drop track here on ${ line.layer } — clearance violation (enable "Allow DRC violations" in Router Settings to override).`);
				session.endTrackDragPreview();
				return;
			}
			// NOT calling simplifyWalkedPath here (stated simplification,
			// corrected after real-world testing): that pass's mergeStep
			// always tries the LARGEST possible bypass span first — for a
			// drag's short [prevA, ...bend..., nextB] chain, that means "try
			// a direct shortcut between the line's own two fixed ends"
			// before anything smaller. Real KiCad's own post-drag optimizer
			// avoids collapsing the user's intentional bend via
			// RESTRICT_AREA/KEEP_TOPOLOGY/SetPreserveVertex constraints
			// (pns_dragger.cpp:569-618) that simplifyWalkedPath — built for
			// walkaround-detour cleanup, where a big simplification IS
			// desired — doesn't have. Committing the raw dragSegment45
			// result directly is correct on its own. What real KiCad DOES
			// run unconditionally-safe post-drag is MERGE_COLINEAR
			// (adjacent-segments-only, no bypass search — see
			// mergeCollinear's doc comment), gated by SmoothDraggedSegments
			// exactly like here; optimizeEntireDraggedTrack (the
			// MERGE_SEGMENTS/mergeFull pass) stays unwired for the reason
			// above.
			const commitPoints: Vec2[] = settings.smoothDraggedSegments
				? mergeCollinear(gesture.lastPreview)
				: gesture.lastPreview;
			const committed = session.dragTrackLine(line.segmentIds, commitPoints, line.width, line.layer, line.netId);
			// A successful incremental commit consumes the hidden original track
			// set itself. On any failure restore those originals normally.
			if (!committed) session.endTrackDragPreview();
			if (committed) {
				this.deps.refreshBoardText(session);
				this.deps.refreshAppearance();
				this.rebuildRouterNode(session);
				this.deps.setStatus('Track dragged.');
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

	/** Hit-tests the selected board polygon's outline handles (see
	 *  KicadRenderSession.getBoardPolygonAnchors/drawZoneEditHandles) — the
	 *  board counterpart of the schematic PointerController's
	 *  curveAnchorAtScreen. A corner within range always wins over a
	 *  midpoint at the same screen position, so an existing vertex is never
	 *  shadowed by its own adjacent edge's midpoint handle. */
	protected polygonOutlineAnchorAtScreen(session: KicadRenderSession, screenPos: Vec2):
		{ paintId: string; corner: number } | { paintId: string; edge: number } | null {
		if (session.selectionIds.size !== 1) {
			return null;
		}
		const paintId = [...session.selectionIds][0]!;
		const anchors = session.getBoardPolygonAnchors(paintId);
		if (!anchors) {
			return null;
		}
		const hitRadius = 9 * (window.devicePixelRatio || 1);
		const closest = (points: Vec2[]): number | null => {
			let bestIndex: number | null = null;
			let bestDistance = Infinity;
			points.forEach((point, index) => {
				const screen = session.camera.worldToScreen(point);
				const distance = Math.hypot(screen.x - screenPos.x, screen.y - screenPos.y);
				if (distance <= hitRadius && distance < bestDistance) {
					bestIndex = index;
					bestDistance = distance;
				}
			});
			return bestIndex;
		};
		const corner = closest(anchors.corners);
		if (corner !== null) {
			return { paintId, corner };
		}
		const edge = closest(anchors.midpoints);
		return edge !== null ? { paintId, edge } : null;
	}

	/** Hit-tests the selected dimension's 5 point-editor handles (see
	 *  KicadRenderSession.getDimensionEditAnchors/drawDimensionEditHandles)
	 *  — same closest-within-radius pattern as polygonOutlineAnchorAtScreen.
	 *  Measured-point handles win over crossbar-end handles at the same
	 *  screen position (checked first), which only matters for a
	 *  height-zero dimension where both coincide. */
	protected dimensionAnchorAtScreen(session: KicadRenderSession, screenPos: Vec2):
		{ paintId: string; kind: 'measured'; index: 0 | 1 }
		| { paintId: string; kind: 'crossbar'; index: 0 | 1 }
		| { paintId: string; kind: 'text' }
		| null {
		if (session.selectionIds.size !== 1) {
			return null;
		}
		const paintId = [...session.selectionIds][0]!;
		const anchors = session.getDimensionEditAnchors(paintId);
		if (!anchors) {
			return null;
		}
		const hitRadius = 9 * (window.devicePixelRatio || 1);
		const closest = (points: Vec2[]): number | null => {
			let bestIndex: number | null = null;
			let bestDistance = Infinity;
			points.forEach((point, index) => {
				const screen = session.camera.worldToScreen(point);
				const distance = Math.hypot(screen.x - screenPos.x, screen.y - screenPos.y);
				if (distance <= hitRadius && distance < bestDistance) {
					bestIndex = index;
					bestDistance = distance;
				}
			});
			return bestIndex;
		};
		const measuredIndex = closest(anchors.measured);
		if (measuredIndex !== null) {
			return { paintId, kind: 'measured', index: measuredIndex as 0 | 1 };
		}
		const crossbarIndex = closest(anchors.crossbar);
		if (crossbarIndex !== null) {
			return { paintId, kind: 'crossbar', index: crossbarIndex as 0 | 1 };
		}
		const textScreen = session.camera.worldToScreen(anchors.text);
		if (Math.hypot(textScreen.x - screenPos.x, textScreen.y - screenPos.y) <= hitRadius) {
			return { paintId, kind: 'text' };
		}
		return null;
	}

	protected resizeHandleAtScreen(session: KicadRenderSession, screenPos: Vec2): {
		handle: ResizeHandle;
		box: SelectionResizeBox;
	} | null {
		const box = session.getSelectionResizeBox();
		if (!box) {
			return null;
		}
		const x2 = box.x + box.width;
		const y2 = box.y + box.height;
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const points = [
			new Vec2(box.x, box.y), new Vec2(cx, box.y), new Vec2(x2, box.y),
			new Vec2(box.x, cy), new Vec2(cx, cy), new Vec2(x2, cy),
			new Vec2(box.x, y2), new Vec2(cx, y2), new Vec2(x2, y2)
		];
		const hitRadius = 9 * (window.devicePixelRatio || 1);
		let closest: { handle: ResizeHandle; distance: number } | null = null;
		for (let index = 0; index < points.length; index++) {
			const point = session.camera.worldToScreen(points[index]!);
			const distance = Math.hypot(point.x - screenPos.x, point.y - screenPos.y);
			if (distance <= hitRadius && (!closest || distance < closest.distance)) {
				closest = { handle: RESIZE_HANDLE_ORDER[index]!, distance };
			}
		}
		return closest ? { handle: closest.handle, box } : null;
	}

	protected resizedBoundsFromHandle(
		box: SelectionResizeBox, handle: Exclude<ResizeHandle, 'center'>, cursor: Vec2
	): SelectionResizeBox {
		let left = box.x;
		let right = box.x + box.width;
		let top = box.y;
		let bottom = box.y + box.height;
		const grid = this.deps.getGridSpacingMm();
		if (handle.includes('w')) left = Math.min(cursor.x, right - grid);
		if (handle.includes('e')) right = Math.max(cursor.x, left + grid);
		if (handle.includes('n')) top = Math.min(cursor.y, bottom - grid);
		if (handle.includes('s')) bottom = Math.max(cursor.y, top + grid);
		return { id: box.id, x: left, y: top, width: right - left, height: bottom - top };
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

	protected isGraphicTool(tool: BoardTool): tool is 'line' | 'arc' | 'rect' | 'circle' | 'polygon' | 'bezier' | 'zone' | 'rule-area' | 'barcode' | 'dimension-aligned' | 'dimension-orthogonal' {
		return tool === 'line' || tool === 'arc' || tool === 'rect' || tool === 'circle' || tool === 'polygon' || tool === 'bezier' || tool === 'zone' || tool === 'rule-area' || tool === 'barcode' || tool === 'dimension-aligned' || tool === 'dimension-orthogonal';
	}

	protected isGraphicPending(pending: PendingShape): boolean {
		return pending.kind === 'anchor' || pending.kind === 'arc' || pending.kind === 'polygon' || pending.kind === 'bezier' || pending.kind === 'zone' || pending.kind === 'rule-area' || pending.kind === 'dimension';
	}

	protected graphicClick(session: KicadRenderSession, screenPos: Vec2, doubleClick: boolean): void {
		const point = this.snappedWorld(session, screenPos);
		const samePoint = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
		switch (this.deps.getTool()) {
			case 'line':
			case 'rect':
			case 'circle': {
				const pending = this.pending.current;
				const anchor = pending.kind === 'anchor' ? pending.start : null;
				if (!anchor) {
					this.pending.set({ kind: 'anchor', start: point });
					return;
				}
				if (samePoint(anchor, point)) {
					this.pending.clear();
					session.setEditPreview(null);
					return;
				}
				const layer = this.deps.getActiveLayer();
				const id = this.deps.getTool() === 'line'
					? session.addBoardGraphicLine(anchor.x, anchor.y, point.x, point.y, layer, BoardPointerController.graphicStrokeWidth)
					: this.deps.getTool() === 'rect'
						? session.addBoardGraphicRect(anchor.x, anchor.y, point.x, point.y, layer, BoardPointerController.graphicStrokeWidth)
						: session.addBoardGraphicCircle(anchor.x, anchor.y, Math.hypot(point.x - anchor.x, point.y - anchor.y), layer, BoardPointerController.graphicStrokeWidth);
				this.commitGraphic(session, id);
				this.pending.clear();
				session.setEditPreview(null);
				return;
			}
			case 'arc': {
				const pending = this.pending.current;
				const points = pending.kind === 'arc' ? pending.points : [];
				if (points.length === 0) this.pending.set({ kind: 'arc', points: [point] });
				else if (points.length === 1) {
					if (samePoint(points[0]!, point)) {
						this.pending.clear();
						session.setEditPreview(null);
					}
					else this.pending.set({ kind: 'arc', points: [points[0]!, point] });
				}
				else {
					this.commitGraphic(session, session.addBoardGraphicArc(
						points[0]!.x, points[0]!.y, point.x, point.y, points[1]!.x, points[1]!.y,
						this.deps.getActiveLayer(), BoardPointerController.graphicStrokeWidth));
					this.pending.clear();
					session.setEditPreview(null);
				}
				return;
			}
			case 'bezier': {
				const pending = this.pending.current;
				const points = pending.kind === 'bezier' ? pending.points : [];
				if (points.length > 0 && samePoint(points[points.length - 1]!, point)) {
					this.pending.clear();
					session.setEditPreview(null);
					return;
				}
				const next = [...points, point];
				if (next.length === 4) {
					this.commitGraphic(session, session.addBoardGraphicBezier(next, this.deps.getActiveLayer(), BoardPointerController.graphicStrokeWidth));
					this.pending.clear();
					session.setEditPreview(null);
				}
				else this.pending.set({ kind: 'bezier', points: next });
				return;
			}
			// Like zone/rule-area (see below), a graphic polygon interrupts the
			// outline gesture with its own Polygon Properties dialog (layer,
			// fill, line width/style) rather than committing straight away.
			case 'polygon': {
				const pending = this.pending.current;
				const points = pending.kind === 'polygon' ? pending.points : [];
				if (points.length >= 3 && (samePoint(points[0]!, point) || doubleClick)) {
					this.pending.clear();
					session.setEditPreview(null);
					this.deps.openPolygonDialogForOutline(points);
				}
				else if (!points.length || !samePoint(points[points.length - 1]!, point)) {
					this.pending.set({ kind: 'polygon', points: [...points, point] });
				}
				return;
			}
			// A zone outline never commits an AST element directly on close
			// (unlike every other graphic tool above) — real KiCad always
			// interrupts the outline gesture with the Copper Zone Properties
			// dialog first (layers/net/clearances), and only creates the zone
			// on that dialog's OK. Cancel there discards the outline entirely,
			// so nothing is added to the AST here at all.
			case 'zone': {
				const pending = this.pending.current;
				const points = pending.kind === 'zone' ? pending.points : [];
				if (points.length >= 3 && (samePoint(points[0]!, point) || doubleClick)) {
					this.pending.clear();
					session.setEditPreview(null);
					this.deps.openZoneDialogForOutline(points);
				}
				else if (!points.length || !samePoint(points[points.length - 1]!, point)) {
					this.pending.set({ kind: 'zone', points: [...points, point] });
				}
				return;
			}
			case 'rule-area': {
				const pending = this.pending.current;
				const points = pending.kind === 'rule-area' ? pending.points : [];
				if (points.length >= 3 && (samePoint(points[0]!, point) || doubleClick)) {
					this.pending.clear();
					session.setEditPreview(null);
					this.deps.openRuleAreaDialogForOutline(points);
				}
				else if (!points.length || !samePoint(points[points.length - 1]!, point)) {
					this.pending.set({ kind: 'rule-area', points: [...points, point] });
				}
				return;
			}
			case 'dimension-aligned':
			case 'dimension-orthogonal': {
				const type = this.deps.getTool() === 'dimension-aligned' ? 'aligned' : 'orthogonal';
				const snapped = this.dimensionAnchorSnap(session, screenPos);
				const pending = this.pending.current;
				const points = pending.kind === 'dimension' && pending.type === type ? pending.points : [];
				if (points.length < 2) {
					if (!points.length || !samePoint(points[0]!, snapped)) {
						this.pending.set({ kind: 'dimension', type, points: [...points, snapped] });
					}
					return;
				}
				this.commitGraphic(session, session.addBoardDimension(type, points[0]!, points[1]!, snapped, this.deps.getActiveLayer()));
				this.pending.clear();
				session.setEditPreview(null);
				return;
			}
			case 'barcode':
				this.deps.openBarcodeDialogForPlacement(point);
				return;
		}
	}

	protected updateGraphicPreview(session: KicadRenderSession, screenPos: Vec2): void {
		const cursor = this.snappedWorld(session, screenPos);
		const pending = this.pending.current;
		const tool = this.deps.getTool();
		switch (tool) {
			case 'line': case 'rect': case 'circle':
				session.setEditPreview({ kind: tool, anchor: pending.kind === 'anchor' ? pending.start : null, cursor });
				break;
			case 'arc': session.setEditPreview({ kind: 'arc', points: pending.kind === 'arc' ? pending.points : [], cursor }); break;
			case 'bezier': session.setEditPreview({ kind: 'bezier', points: pending.kind === 'bezier' ? pending.points : [], cursor }); break;
			case 'polygon': session.setEditPreview({ kind: 'rule-area', points: pending.kind === 'polygon' ? pending.points : [], cursor }); break;
			case 'zone': session.setEditPreview({ kind: 'rule-area', points: pending.kind === 'zone' ? pending.points : [], cursor }); break;
			case 'rule-area': session.setEditPreview({ kind: 'rule-area', points: pending.kind === 'rule-area' ? pending.points : [], cursor }); break;
			case 'dimension-aligned':
			case 'dimension-orthogonal':
				session.setEditPreview({
					kind: 'dimension', type: tool === 'dimension-aligned' ? 'aligned' : 'orthogonal',
					points: pending.kind === 'dimension' ? pending.points : [],
					cursor: this.dimensionAnchorSnap(session, screenPos)
				});
				break;
		}
	}

	/** Pcbnew uses the rectangle-placement gesture for text boxes, then opens
	 *  the text properties dialog. The floating text editor is this app's
	 *  equivalent while retaining the same corner-to-corner interaction. */
	protected textBoxClick(session: KicadRenderSession, screenPos: Vec2, event: MouseEvent): void {
		const point = this.snappedWorld(session, screenPos);
		const pending = this.pending.current;
		const anchor = pending.kind === 'anchor' ? pending.start : null;
		if (!anchor) {
			this.pending.set({ kind: 'anchor', start: point });
			return;
		}
		if (anchor.x === point.x || anchor.y === point.y) {
			this.pending.clear();
			session.setEditPreview(null);
			this.deps.setStatus('A text box needs two distinct corners.');
			return;
		}
		this.pending.clear();
		session.setEditPreview(null);
		this.deps.showTextBoxInput(anchor, point, event);
	}

	protected updateTextBoxPreview(session: KicadRenderSession, screenPos: Vec2): void {
		const pending = this.pending.current;
		if (pending.kind !== 'anchor') {
			return;
		}
		const cursor = this.snappedWorld(session, screenPos);
		session.setEditPreview({
			kind: 'text-box',
			x: Math.min(pending.start.x, cursor.x),
			y: Math.min(pending.start.y, cursor.y),
			width: Math.abs(cursor.x - pending.start.x),
			height: Math.abs(cursor.y - pending.start.y),
			text: ''
		});
	}

	protected commitGraphic(session: KicadRenderSession, id: string | null): void {
		if (!id) return;
		session.select(id);
		this.deps.refreshBoardText(session);
		this.deps.refreshAppearance();
	}

	/** Grid-snapped world position for a route click/hover, upgraded to the
	 *  nearest pad/via/track-endpoint anchor within pick tolerance if one is
	 *  close by — matches real KiCad always landing a route on the exact
	 *  center of whatever connection point it's near, never wherever inside
	 *  the pad's own outline the cursor happened to be. Returns the anchor's
	 *  netId too (null if the snap point isn't a real anchor) so callers
	 *  don't need a second lookup, plus `snapped` for callers that only care
	 *  whether a real anchor was found — the tolerance here is deliberately
	 *  much larger than a plain hit-test click radius (real KiCad's router
	 *  "magnetizes" onto a connection from well outside the pad's own
	 *  outline, not just a few pixels around its exact center — user
	 *  feedback after the first pass used too tight a radius to feel like
	 *  snapping at all). */
	protected routeAnchorSnap(session: KicadRenderSession, screenPos: Vec2, netFilter?: number | null): { point: Vec2; netId: number | null; snapped: boolean; trackWidth?: number } {
		const point = this.snappedWorld(session, screenPos);
		const anchor = session.nearestAnchorPoint(session.screenToWorld(screenPos), session.pickToleranceWorld * 8, netFilter);
		return anchor
			? { point: anchor.point, netId: anchor.netId, snapped: true, trackWidth: anchor.kind === 'track' ? anchor.width : undefined }
			: { point, netId: null, snapped: false };
	}

	/** Dimension-tool counterpart to routeAnchorSnap — real KiCad's dimension
	 *  tool magnetizes onto pad/footprint/graphic-item anchors via the SAME
	 *  grid helper every other drawing tool uses (see nearestBoardGraphicAnchor's
	 *  doc comment), falling back to plain grid-snap when nothing is close
	 *  enough. Not net-filtered — a dimension isn't an electrical item. */
	protected dimensionAnchorSnap(session: KicadRenderSession, screenPos: Vec2): Vec2 {
		const anchor = session.nearestBoardGraphicAnchor(session.screenToWorld(screenPos), session.pickToleranceWorld * 8);
		return anchor ?? this.snappedWorld(session, screenPos);
	}

	/** The net a route-tool anchor-snap should be restricted to right now —
	 *  null (no filter, any net or net-less anchors match) before a route
	 *  has started, otherwise the pending route's own net. Centralizes the
	 *  [[kicad-viewer-interactive-router-port]] fix for anchors magnetizing
	 *  across nets (e.g. a +5V route's cursor/corner snapping onto a nearby
	 *  GND pad) — every anchor-snap after the route's start point should use
	 *  this, not call routeAnchorSnap with no filter. */
	protected currentRouteNetFilter(): number | null {
		const pending = this.pending.current;
		return pending.kind === 'route' ? pending.netId : null;
	}

	/** The board editor's current WORKING point — what the crosshair cursor
	 *  should actually be drawn at (see KicadRenderSession.workingPointWorld's
	 *  doc comment). Anchor-snapped while the route tool is selected (the
	 *  connection-magnetizing behavior users actually care about seeing);
	 *  plain grid-snapped mouse position otherwise, matching every other
	 *  tool's own snap-to-grid placement. */
	protected computeWorkingPoint(session: KicadRenderSession, screenPos: Vec2): Vec2 {
		if (this.deps.getTool() === 'route') {
			return this.routeAnchorSnap(session, screenPos, this.currentRouteNetFilter()).point;
		}
		return this.snappedWorld(session, screenPos);
	}

	protected routeClick(session: KicadRenderSession, screenPos: Vec2, finish: boolean): void {
		// Bind the canonical router's world + settings to the current scene.
		const tool = session.prepareRouteTool() ?? session.getRouteTool();
		const rs = this.deps.getRouterSettings();
		tool.setClearanceResolver(this.clearanceResolver(session));
		tool.SetMode(rs.mode);
		tool.SetCornerMode(this.deps.getCornerMode());
		tool.SetAllowDrcViolations(rs.allowDrcViolations);
		if (!tool.IsRouting()) {
			// Start a new route: snap to an anchor (pad/via/track-end), pick up
			// its net; fall back to a ratsnest-endpoint if no copper is near.
			const snap = this.routeAnchorSnap(session, screenPos);
			let netId = snap.netId ?? session.netIdAtScreen(screenPos);
			let startPoint = snap.point;
			if (netId === null || netId <= 0) {
				const near = session.nearestRatsnestPoint(startPoint, session.pickToleranceWorld * 3);
				if (near) {
					netId = near.netId;
					startPoint = near.point;
				}
			}
			if (netId !== null && netId > 0) {
				tool.SetWidth(this.deps.getRoutingSizes(session.netNameForId(netId)).trackWidth);
			}
			tool.SetLayer(this.deps.getActiveLayer());
			tool.SelectStart(startPoint, snap.snapped ? [{ pos: snap.point, netId: snap.netId, kind: 'track-end' }] : []);
			this.pending.set({
				kind: 'route',
				netId,
				layer: this.deps.getActiveLayer(),
				corners: [startPoint],
				connectedWidth: this.deps.getUseConnectedTrackWidth() ? snap.trackWidth : undefined
			});
			this.rebuildRouterNode(session);
			this.updateRoutePreview(session, screenPos);
			this.deps.setStatus(`Routing on ${ this.deps.getActiveLayer() } — click to add a corner. Enter/double-click finishes.`);
			return;
		}
		// Routing: fix the current corner via the canonical router, then chain.
		const pending = this.pending.current;
		if (pending.kind !== 'route') {
			return;
		}
		const point = this.routeAnchorSnap(session, screenPos, pending.netId).point;
		const { added, blocked } = this.commitRouteTo(session, pending, point);
		if (blocked) {
			this.deps.setStatus(`Routing on ${ pending.layer } — can't place here, clearance violation (enable "Allow DRC violations" in Router Settings to override).`);
			return;
		}
		if (added) {
			this.deps.refreshBoardText(session);
			this.deps.refreshAppearance();
			this.rebuildRouterNode(session);
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
		const tool = session.getRouteTool();
		if (!tool.IsRouting()) {
			session.setEditPreview(null);
			return;
		}
		const cursor = this.routeAnchorSnap(session, screenPos, pending.netId).point;
		const gesture = tool.MoveCursor(cursor);
		const width = pending.connectedWidth ?? this.deps.getRoutingSizes(session.netNameForId(pending.netId)).trackWidth;
		const points = tool.ghostPoints();
		const settings = this.deps.getRouterSettings();
		// Shove mode never mutates during preview — the canonical router's
		// move() only reports whether a shove would resolve (detoured/collides),
		// matching real KiCad's dry shove planning; the live view doesn't flash
		// red for something that's about to be pushed aside at commit time.
		const collides = gesture.collides && settings.mode === 'shove' ? false : gesture.collides;
		session.setEditPreview({
			kind: 'route',
			points: points.slice(0, -1),
			cursor: points[points.length - 1] ?? cursor,
			width,
			collides
		});
		if (collides) {
			this.deps.setStatus(settings.allowDrcViolations
				? `Routing on ${ pending.layer } — clearance violation, still placeable (DRC violations allowed).`
				: `Routing on ${ pending.layer } — clearance violation, can't place here.`);
		}
	}

	/** Checks a candidate path against routerNode, layer/segment by segment
	 *  — true if ANY leg violates clearance. */
	protected pathCollides(
		path: Vec2[], width: number, layer: string, netId: number | null,
		clearanceFn: (a: number | null, b: number | null) => number,
	): boolean {
		if (!this.routerNode) {
			return false;
		}
		for (let index = 1; index < path.length; index++) {
			const a = path[index - 1]!, b = path[index]!;
			if (this.routerNode.firstSegmentCollision(a.x, a.y, b.x, b.y, width, layer, netId, clearanceFn)) {
				return true;
			}
		}
		return false;
	}

	/** Iteratively walks around every obstacle the candidate path collides
	 *  with in turn — real KiCad's WALKAROUND::Route() (pns_walkaround.cpp)
	 *  keeps re-walking the SAME evolving LINE against whatever it collides
	 *  with next, up to an iteration limit, rather than trying only the
	 *  first obstacle and giving up. That's what makes real KiCad "try
	 *  really hard" at tight (~1mm) spacing where a route's path threads
	 *  past several packed pads/vias in a row: each one gets walked around
	 *  in sequence, using PnsWalkaround.pnsWalkaround's already-general
	 *  multi-point-path support (it doesn't care whether `path` is the raw
	 *  [from,to] leg or an already-bent result from walking around the
	 *  previous obstacle). Bails (returns null) if an obstacle can't be
	 *  walked around, or if the path keeps growing without ever clearing
	 *  everything (the same length-expansion safety net real KiCad's
	 *  m_lengthExpansionFactor uses).
	 *
	 *  Starts from `initialPath` (the corner-mode-constrained candidate from
	 *  buildRoutePath), NOT a raw direct [from,to] line — real KiCad's own
	 *  rhWalkBase (pns_line_placer.cpp) always builds this same kind of
	 *  DIRECTION_45-constrained "head" via buildInitialLine() BEFORE handing
	 *  it to WALKAROUND::Route(). Seeding with a raw diagonal line was the
	 *  root cause of walkaround producing arbitrary-angle bends: the
	 *  octagonal hulls this router builds (see PnsHull.ts) only ever expose
	 *  axis-aligned or exactly-45° edges, so the ONLY way a non-45 bend can
	 *  appear is from the path's own un-constrained base segments — see
	 *  [[kicad-viewer-interactive-router-port]]. */
	protected walkAroundObstacles(
		session: KicadRenderSession, from: Vec2, to: Vec2, initialPath: Vec2[],
		pending: { layer: string; netId: number | null }, width: number,
	): Vec2[] | null {
		const routerNode = this.routerNode;
		if (!routerNode) {
			return null;
		}
		const clearanceFn = this.clearanceResolver(session);
		const half = width / 2;
		const straightLength = Math.hypot(to.x - from.x, to.y - from.y);
		const maxLength = Math.max(straightLength * 8, half * 40);
		// 90°-only corner mode never routes an octagon's 45° chamfer — matches
		// real KiCad's own WALKAROUND::singleStep() collapsing the hull to its
		// bbox rect whenever the posture is MITERED_90/ROUNDED_90 (see
		// buildClearanceHull's simplifyToRect doc comment).
		const rectOnly = this.deps.getCornerMode() === '90';
		// Real KiCad's rhWalkBase runs OPTIMIZER::Optimize(MERGE_SEGMENTS) on
		// every walkaround result before picking a winding — without this, a
		// walk that correctly hugs every vertex of an obstacle's hull (right,
		// but not minimal) never gets shortcut down to the tight trapezoid
		// real KiCad produces for the same obstacle. checkColliding here mirrors
		// real KiCad's own (queries the WHOLE world, not just the hull that was
		// walked around — a shortcut is only valid if it stays clear of
		// everything).
		const simplify = (path: { x: number; y: number }[]): { x: number; y: number }[] => simplifyWalkedPath(path, (a, b) =>
			!!routerNode.firstSegmentCollision(a.x, a.y, b.x, b.y, width, pending.layer, pending.netId, clearanceFn));
		let currentPath: { x: number; y: number }[] = initialPath;
		const MAX_ITERATIONS = 25;
		for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
			let firstHit: ReturnType<RouterNode['firstSegmentCollision']> = null;
			for (let index = 1; index < currentPath.length && !firstHit; index++) {
				const a = currentPath[index - 1]!, b = currentPath[index]!;
				firstHit = routerNode.firstSegmentCollision(a.x, a.y, b.x, b.y, width, pending.layer, pending.netId, clearanceFn);
			}
			if (!firstHit) {
				this.deps.dbg('walkaround: clear after', iteration, 'iteration(s)');
				return currentPath as Vec2[];
			}
			const requiredGap = clearanceFn(pending.netId, firstHit.netId) + half;
			const hull = buildClearanceHull(firstHit.shape, requiredGap, rectOnly);
			const failInfo: { reason: string; info?: Record<string, unknown> }[] = [];
			const next = walkaroundHull(currentPath, hull, (reason, info) => failInfo.push({ reason, info }), simplify);
			if (!next) {
				this.deps.dbg('walkaround: stuck on iteration', iteration, {
					obstacleId: firstHit.id, obstacleKind: firstHit.kind, obstacleNetId: firstHit.netId,
					obstacleShape: firstHit.shape, requiredGap, width, half,
					hullPoints: hull.length, hull, failInfo,
					path: currentPath,
				});
				return null;
			}
			if (pathLength(next) > maxLength) {
				this.deps.dbg('walkaround: bailed, path exceeded length limit', { maxLength, gotLength: pathLength(next) });
				return null;
			}
			currentPath = next;
		}
		this.deps.dbg('walkaround: hit iteration limit', MAX_ITERATIONS);
		return null;
	}

	/** Shared core of the route/drag shove planner — extracted so a
	 *  mid-segment track drag (BoardPointerController's dragged-line preview,
	 *  which already has its own candidate path from dragSegment45 and has no
	 *  "from/to" to rebuild a corner-mode route between) can reuse the exact
	 *  same shove-planning logic instead of a second copy. Computes a reroute
	 *  of the one colliding TRACK segment around the new route via
	 *  RouterGeometry.shoveTrackPath, single-obstacle/non-mutating. */
	protected planShoveForPath(
		session: KicadRenderSession, path: Vec2[], layer: string, netId: number | null, width: number,
	): { element: any; segments: { x1: number; y1: number; x2: number; y2: number }[] } | null {
		if (!this.routerNode) {
			return null;
		}
		const clearanceFn = this.clearanceResolver(session);
		for (let index = 1; index < path.length; index++) {
			const a = path[index - 1]!, b = path[index]!;
			const hit = this.routerNode.firstSegmentCollision(a.x, a.y, b.x, b.y, width, layer, netId, clearanceFn);
			if (!hit || hit.kind !== 'track' || hit.shape.type !== 'segment') {
				continue;
			}
			const obstacle = hit.shape;
			const requiredClearance = clearanceFn(netId, hit.netId);
			const shovePath = shoveTrackPath(
				obstacle.x1, obstacle.y1, obstacle.x2, obstacle.y2, obstacle.width / 2,
				a.x, a.y, b.x, b.y, width / 2, requiredClearance);
			if (!shovePath) {
				return null;
			}
			let clear = true;
			for (let i = 1; i < shovePath.length && clear; i++) {
				const p1 = shovePath[i - 1]!, p2 = shovePath[i]!;
				clear = !this.routerNode.firstSegmentCollision(
					p1.x, p1.y, p2.x, p2.y, obstacle.width, hit.layer, hit.netId, clearanceFn, hit.id);
			}
			if (!clear) {
				return null;
			}
			const segments = shovePath.slice(1).map((p, i) => ({ x1: shovePath[i]!.x, y1: shovePath[i]!.y, x2: p.x, y2: p.y }));
			return { element: hit.element, segments };
		}
		return null;
	}

	/** Builds a (candidateNetId, obstacleNetId) -> clearanceMm resolver for
	 *  RouterNode's collision queries, backed by the project's real net
	 *  classes (NetClassResolver.resolveClearanceMm) instead of one flat
	 *  board-wide number — a net with a tighter/looser class than Default
	 *  gets its own actual clearance requirement against whatever it's
	 *  routed near. */
	protected clearanceResolver(session: KicadRenderSession): (a: number | null, b: number | null) => number {
		const rules = this.deps.getNetClassRules();
		return (a, b) => resolveClearanceMm(session.netNameForId(a) ?? '', session.netNameForId(b) ?? '', rules);
	}

	/** Rebuilds routerNode from the session's current board scene — call
	 *  after anything that changes the board's copper (route start, a
	 *  committed corner, a placed via). A stale node would only ever be
	 *  MISSING the newest copper (never show a false collision), so skipping
	 *  a rebuild on a path that doesn't touch the AST is safe, not just an
	 *  optimization. */
	protected rebuildRouterNode(session: KicadRenderSession): void {
		const scene = session.documentTypeLoaded === 'board' ? session.activeScene as
			{ layerBuckets: Map<string, unknown[]>; copperLayerStack: string[] } | null : null;
		this.routerNode = scene ? RouterNode.fromScene(scene as any, scene.copperLayerStack ?? []) : null;
	}

	protected placeVia(session: KicadRenderSession, screenPos: Vec2, continueRoute = false): boolean {
		const point = this.snappedWorld(session, screenPos);
		const pending = this.pending.current;
		const netId = pending.kind === 'route' ? pending.netId : session.netIdAtScreen(screenPos);
		let routedAdded = 0;
		if (pending.kind === 'route' && continueRoute) {
			const result = this.commitRouteTo(session, pending, point);
			if (result.blocked) {
				this.deps.setStatus('Via placement blocked — clearance violation on the connecting track (enable "Allow DRC violations" in Router Settings to override).');
				return false;
			}
			routedAdded = result.added;
		}
		const sizes = this.deps.getRoutingSizes(session.netNameForId(netId));
		const id = session.addVia(
			point.x, point.y, sizes.viaSize, sizes.viaDrill,
			this.deps.getViaLayerPair(), netId, routedAdded === 0);
		if (!id) {
			return false;
		}
		this.deps.refreshBoardText(session);
		this.deps.refreshAppearance();
		this.rebuildRouterNode(session);
		if (pending.kind === 'route' && continueRoute) {
			this.pending.set({ ...pending, corners: [...pending.corners, point] });
		}
		this.deps.setStatus(`Via placed at ${ point.x.toFixed(3) }, ${ point.y.toFixed(3) } mm.`);
		return true;
	}

	/** Commits one route leg. Returns `blocked: true` (and adds nothing) when
	 *  the final candidate path still collides and RouterSettings.
	 *  allowDrcViolations is off — real KiCad's LINE_PLACER::FixRoute refuses
	 *  to fix a colliding line unless that setting is checked, regardless of
	 *  mode (pns_line_placer.cpp: "Collisions still prevent fixing unless
	 *  'Allow DRC violations' is checked"). This is what actually stops a
	 *  track from landing on a different-net pad — earlier, computeRoutePath
	 *  only ever coloured the preview red without this gate, so a still-
	 *  colliding path got committed anyway. */
	protected commitRouteTo(
		session: KicadRenderSession,
		pending: Extract<PendingShape, { kind: 'route' }>,
		point: Vec2
	): { added: number; blocked: boolean } {
		const settings = this.deps.getRouterSettings();
		const tool = session.getRouteTool();
		// Shove only actually moves copper here, at commit time — the live
		// preview (MoveCursor, called from updateRoutePreview too) deliberately
		// never mutates the board, so a mouse move alone never nudges someone
		// else's track; only actually clicking to place does. The router engine
		// plans a shove during move() and applies it as part of fixRoute().
		const commit = tool.Fix(point);
		if (!commit) {
			// Couldn't commit — the canonical router returns null when the
			// final path still collides and "Allow DRC violations" is off, or
			// the route is degenerate. Match real KiCad refusing a colliding
			// fix regardless of mode.
			return { added: 0, blocked: true };
		}
		// Apply shoved tracks (canonical router's committed shove plan).
		for (const shoved of commit.shoved) {
			session.shoveTrackSegment(shoved.obstacle.element, shoved.segments);
		}
		// Add the committed segments.
		let added = 0;
		for (const seg of commit.segments) {
			if (session.addTrackSegment(
				seg.x1, seg.y1, seg.x2, seg.y2,
				seg.width, seg.layer, seg.netId,
				added === 0)) {
				added++;
			}
		}
		if (added > 0 && settings.removeRedundantTracks) {
			session.cleanupTracks();
		}
		return { added, blocked: false };
	}
}
