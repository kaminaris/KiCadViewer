import type {
	KicadRenderSession, SelectionResizeBox, ResizeHandle, EditPreviewState, CurveAnchor, SelectionCurveAnchors
} from '@kicad-render/KicadRenderSession';
import { Vec2 } from '@kicad-render/math/Vec2';
import type { AppMode } from '../app/AppState';
import type { EditTool } from './Toolbar';
import type { EditGestureTracker } from './EditGesture';
import { TEXT_INPUT_TOOLS } from './TextInputFlow';
import type { EditorRuntimeState } from './EditorRuntimeState';

const RECT_SELECT_MOVE_THRESHOLD_PX = 4;
const RESIZE_HANDLE_ORDER: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se'];

export interface PointerControllerDeps {
	canvas: HTMLCanvasElement;
	/** The WebGL canvas overlaid at the same position — whichever of the two
	 *  is actually visible needs its own listeners, since a hidden
	 *  (display:none) canvas never receives pointer events. */
	canvasGl: HTMLCanvasElement;
	/** Shared parent of both canvases — used for getBoundingClientRect()
	 *  instead of `canvas` specifically, since canvas2d is display:none
	 *  whenever WebGL is active and a hidden element's rect is all zeros.
	 *  Both canvases fill .stage exactly, so its rect is always right. */
	stage: HTMLElement;
	runtime: EditorRuntimeState;
	editGestureTracker: EditGestureTracker;
	getSession(): KicadRenderSession | null;
	ensureSession(): KicadRenderSession;
	ensurePlacement(ref: string): any | null;
	getMode(): AppMode;
	getCircuitDragMode(): boolean;
	getEditTool(): EditTool;
	getHighlightNetEnabled(): boolean;
	getCurrentPowerKind(): 'gnd' | 'flag' | 'rail';
	getGridSpacingMm(): number;
	getContextMenuOpen(): boolean;
	getPropertiesModalOpen(): boolean;
	getSymbolChooserOpen(): boolean;
	updateStatusBar(screenPos?: Vec2): void;
	snap(value: number): number;
	commitReroute(connectivity: 'autoroute' | 'clear-wires'): Promise<void>;
	refreshSchematicText(session: KicadRenderSession): void;
	syncSingleSelectionBookkeeping(session: KicadRenderSession): void;
	updateEditSidebar(): void;
	setSelectedRef(reference: string | null): void;
	getEditSelectedId(): string | null;
	setEditSelectedId(id: string | null): void;
	getEditSelectedKind(): string | null;
	setEditSelectedKind(kind: string | null): void;
	dbg(...args: unknown[]): void;
	getPlacements(): any[];
	isEditablePowerPlacement(placement: any): boolean;
	getRuleAreaPoints(): Vec2[];
	setRuleAreaPoints(points: Vec2[]): void;
	getLineChainStart(): Vec2 | null;
	setLineChainStart(value: Vec2 | null): void;
	getShapeAnchor(): Vec2 | null;
	setShapeAnchor(value: Vec2 | null): void;
	getArcPoints(): Vec2[];
	setArcPoints(points: Vec2[]): void;
	getBezierPoints(): Vec2[];
	setBezierPoints(points: Vec2[]): void;
	showTextInput(worldAnchor: Vec2, event: MouseEvent): void;
	showTextBoxInput(first: Vec2, second: Vec2, event: MouseEvent): void;
	placeSymbolAt(snapped: Vec2): void;
	tryPlacePendingImage(snapped: Vec2): void;
	setStatus(message: string): void;
	showTableModal(anchor: Vec2): void;
	showTableEditModal(id: string): void;
	showPropertiesModal(id: string): void;
	/** Double-click-a-sheet-symbol-to-descend, only meaningful when a whole
	 *  project (not a single loose file) is open — see
	 *  SessionController.descendIntoSheetAtScreen. Resolves false when
	 *  there's nothing to descend into (no project open, or no sheet symbol
	 *  under the cursor), letting the caller fall through to normal
	 *  view-mode behavior (pan-drag) unchanged. */
	descendIntoSheetAtScreen(screenPos: Vec2): Promise<boolean>;
}

/** Owns canvas/window pointer event flow and drag commit behavior. */
export class PointerController {
	constructor(protected readonly deps: PointerControllerDeps) {
		for (const el of [deps.canvas, deps.canvasGl]) {
			el.addEventListener('mousedown', event => this.onMouseDown(event));
			el.addEventListener('dblclick', event => this.onDoubleClick(event));
		}
		window.addEventListener('mousemove', event => this.onPointerMove(event));
		window.addEventListener('mouseup', event => this.onPointerUp(event));
	}

	protected selectAndSync(session: KicadRenderSession, id: string | null): void {
		session.select(id);
		this.deps.syncSingleSelectionBookkeeping(session);
	}

	protected onMouseDown(e: MouseEvent): void {
		if (this.deps.getContextMenuOpen() || this.deps.getPropertiesModalOpen() || this.deps.getSymbolChooserOpen()) {
			return;
		}
		const session = this.deps.ensureSession();
		const screenPos = this.screenPosFromEvent(e);
		if (this.deps.getHighlightNetEnabled() && e.button === 0) {
			const highlighted = session.highlightNetAtScreen(screenPos);
			if (highlighted) {
				e.preventDefault();
				return;
			}
		}
		if (this.deps.getMode() === 'edit') {
			if (this.handleEditModeMouseDown(e, session, screenPos)) {
				return;
			}
			this.deps.runtime.draggingPan = true;
			this.deps.runtime.dragStart = screenPos;
			return;
		}
		if (this.deps.getMode() === 'circuit' && this.deps.getCircuitDragMode()) {
			const symbolHit = session.hitTestSymbolAtScreen(screenPos);
			this.deps.dbg('mousedown hit', symbolHit);
			if (symbolHit?.refDesignator) {
				this.deps.setSelectedRef(symbolHit.refDesignator);
				this.selectAndSync(session, symbolHit.id);
				this.beginSymbolDrag(symbolHit.refDesignator, screenPos);
				e.preventDefault();
				return;
			}
			const labelHit = session.hitTestLabelAtScreen(screenPos);
			if (labelHit?.id && labelHit.labelKind && labelHit.labelKind !== 'local') {
				this.deps.setSelectedRef(null);
				this.selectAndSync(session, labelHit.id);
				session.pushUndoSnapshot();
				const world = session.screenToWorld(screenPos);
				const hitItem = (session as any).schScene?.hitTestItems?.find((it: any) => it.id === labelHit.id);
				const fieldOrigin = (hitItem as any)?.fieldOrigin;
				const origin = fieldOrigin
					? { x: fieldOrigin.x, y: fieldOrigin.y, rotation: fieldOrigin.rotation ?? 0 }
					: (hitItem?.element as any)?.getOrigin?.() ?? { x: world.x, y: world.y, rotation: 0 };
				const startPose = { x: origin.x, y: origin.y, rotation: origin.rotation ?? 0 };
				const offset = new Vec2(world.x - origin.x, world.y - origin.y);
				this.deps.runtime.dragMoved = false;
				this.deps.editGestureTracker.begin({ kind: 'label', id: labelHit.id, offset, startPose });
				e.preventDefault();
				return;
			}
			this.deps.setSelectedRef(null);
			this.selectAndSync(session, null);
		}
		this.deps.runtime.draggingPan = true;
		this.deps.runtime.dragStart = screenPos;
	}

	protected updateEditPreview(session: KicadRenderSession, cursor: Vec2): void {
		let preview: EditPreviewState | null;
		const editTool = this.deps.getEditTool();
		switch (editTool) {
			case 'wire':
			case 'bus':
				preview = this.deps.getLineChainStart() ? { kind: 'wire', from: this.deps.getLineChainStart()!, cursor } : null;
				break;
			case 'junction':
			case 'bus-entry':
				preview = { kind: 'junction', cursor };
				break;
			case 'no-connect':
				preview = { kind: 'no-connect', cursor };
				break;
			case 'line':
			case 'rect':
			case 'circle':
				preview = { kind: editTool, anchor: this.deps.getShapeAnchor(), cursor };
				break;
			case 'text-box': {
				const shapeAnchor = this.deps.getShapeAnchor();
				preview = shapeAnchor
					? {
						kind: 'text-box',
						x: Math.min(shapeAnchor.x, cursor.x),
						y: Math.min(shapeAnchor.y, cursor.y),
						width: Math.abs(cursor.x - shapeAnchor.x),
						height: Math.abs(cursor.y - shapeAnchor.y),
						text: ''
					}
					: null;
				break;
			}
			case 'arc':
				preview = { kind: 'arc', points: this.deps.getArcPoints(), cursor };
				break;
			case 'bezier':
				preview = { kind: 'bezier', points: this.deps.getBezierPoints(), cursor };
				break;
			case 'rule-area':
				preview = { kind: 'rule-area', points: this.deps.getRuleAreaPoints(), cursor };
				break;
			case 'power':
				preview = this.deps.getCurrentPowerKind() !== 'rail' ? { kind: 'power', cursor } : null;
				break;
			default:
				preview = null;
		}
		session.setEditPreview(preview);
	}

	protected handleEditModeMouseDown(e: MouseEvent, session: KicadRenderSession, screenPos: Vec2): boolean {
		const worldPos = session.screenToWorld(screenPos);
		this.deps.runtime.lastPointerWorld = worldPos;
		const snapped = new Vec2(this.deps.snap(worldPos.x), this.deps.snap(worldPos.y));
		const samePoint = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
		const editTool = this.deps.getEditTool();

		if (editTool === 'select') {
			if (e.button !== 0) {
				return false;
			}
			const curveAnchor = this.curveAnchorAtScreen(session, screenPos);
			if (curveAnchor) {
				this.deps.setSelectedRef(null);
				this.deps.setEditSelectedId(curveAnchor.curve.id);
				this.deps.setEditSelectedKind('curve');
				session.pushUndoSnapshot();
				this.deps.editGestureTracker.begin({ kind: 'curve', id: curveAnchor.curve.id, anchor: curveAnchor.anchor });
				e.preventDefault();
				return true;
			}
			const resizeHandle = this.resizeHandleAtScreen(session, screenPos);
			if (resizeHandle) {
				this.deps.setSelectedRef(null);
				this.deps.setEditSelectedId(resizeHandle.box.id);
				this.deps.setEditSelectedKind('resize-box');
				session.pushUndoSnapshot();
				if (resizeHandle.handle === 'center') {
					this.deps.editGestureTracker.begin({ kind: 'element', id: resizeHandle.box.id, lastSnapped: snapped });
				}
				else {
					this.deps.editGestureTracker.begin({
						kind: 'resize',
						id: resizeHandle.box.id,
						handle: resizeHandle.handle,
						original: resizeHandle.box
					});
				}
				e.preventDefault();
				return true;
			}
			const hit = session.hitTestAtScreen(screenPos);
			const clickSelectMode = this.rectSelectionModeFromModifiers(e);
			if (hit && clickSelectMode !== 'replace') {
				session.selectMultiple([hit.id], clickSelectMode);
				this.deps.syncSingleSelectionBookkeeping(session);
				e.preventDefault();
				return true;
			}
			if (hit) {
				const expanded = session.expandGroupSelection([hit.id]);
				if (expanded.length > 1) {
					session.selectMultiple(expanded, 'replace');
					this.deps.syncSingleSelectionBookkeeping(session);
					this.deps.editGestureTracker.begin({ kind: 'group', lastSnapped: snapped });
					this.deps.runtime.dragMoved = false;
					e.preventDefault();
					return true;
				}
			}
			if (hit && session.selectionIds.size > 1 && session.selectionIds.has(hit.id)) {
				this.deps.editGestureTracker.begin({ kind: 'group', lastSnapped: snapped });
				this.deps.runtime.dragMoved = false;
				e.preventDefault();
				return true;
			}
			if (hit?.kind === 'symbol' && hit.refDesignator) {
				this.deps.setSelectedRef(hit.refDesignator);
				this.deps.setEditSelectedId(hit.id);
				this.deps.setEditSelectedKind(hit.kind);
				this.selectAndSync(session, hit.id);
				this.beginEditSymbolDrag(hit.refDesignator, hit.id, screenPos);
				e.preventDefault();
				return true;
			}
			if (hit?.kind === 'sheet') {
				this.deps.setSelectedRef(null);
				this.deps.setEditSelectedId(hit.id);
				this.deps.setEditSelectedKind(hit.kind);
				this.selectAndSync(session, hit.id);
				this.beginSheetDrag(hit.id, screenPos);
				e.preventDefault();
				return true;
			}
			if (hit?.kind === 'label' && hit.labelKind === 'sheet-pin') {
				this.deps.setSelectedRef(null);
				this.deps.setEditSelectedId(hit.id);
				this.deps.setEditSelectedKind(hit.kind);
				this.selectAndSync(session, hit.id);
				this.beginSheetPinDrag(hit.id, screenPos);
				e.preventDefault();
				return true;
			}
			if (hit?.kind === 'label') {
				this.deps.setSelectedRef(null);
				this.deps.setEditSelectedId(hit.id);
				this.deps.setEditSelectedKind(hit.kind);
				this.selectAndSync(session, hit.id);
				session.pushUndoSnapshot();
				const hitItem = (session as any).schScene?.hitTestItems?.find((item: any) => item.id === hit.id);
				const fieldOrigin = (hitItem as any)?.fieldOrigin;
				const origin = fieldOrigin
					? { x: fieldOrigin.x, y: fieldOrigin.y, rotation: fieldOrigin.rotation ?? 0 }
					: (hitItem?.element as any)?.getOrigin?.() ?? worldPos;
				const startPose = { x: origin.x, y: origin.y, rotation: origin.rotation ?? 0 };
				const offset = new Vec2(worldPos.x - origin.x, worldPos.y - origin.y);
				this.deps.runtime.dragMoved = false;
				this.deps.editGestureTracker.begin({ kind: 'label', id: hit.id, offset, startPose });
				e.preventDefault();
				return true;
			}
			if (hit) {
				this.deps.setSelectedRef(null);
				this.deps.setEditSelectedId(hit.id);
				this.deps.setEditSelectedKind(hit.kind);
				this.selectAndSync(session, hit.id);
				session.pushUndoSnapshot();
				this.deps.editGestureTracker.begin({ kind: 'element', id: hit.id, lastSnapped: snapped });
				e.preventDefault();
				return true;
			}
			this.deps.editGestureTracker.begin({ kind: 'rect-select', originWorld: worldPos, originScreen: screenPos });
			this.deps.runtime.dragMoved = false;
			e.preventDefault();
			return true;
		}

		if (editTool === 'wire' || editTool === 'bus') {
			if (e.button === 2) {
				this.deps.setLineChainStart(null);
				session.setEditPreview(null);
				e.preventDefault();
				return true;
			}
			const lineChainStart = this.deps.getLineChainStart();
			if (!lineChainStart) {
				this.deps.setLineChainStart(snapped);
			}
			else if (samePoint(snapped, lineChainStart)) {
				this.deps.setLineChainStart(null);
				session.setEditPreview(null);
			}
			else {
				if (editTool === 'wire') {
					session.addWire(lineChainStart.x, lineChainStart.y, snapped.x, snapped.y);
				}
				else {
					session.addBus(lineChainStart.x, lineChainStart.y, snapped.x, snapped.y);
				}
				this.deps.refreshSchematicText(session);
				this.deps.setLineChainStart(snapped);
			}
			e.preventDefault();
			return true;
		}

		if (editTool === 'bus-entry') {
			session.addBusEntry(snapped.x, snapped.y);
			this.deps.refreshSchematicText(session);
			e.preventDefault();
			return true;
		}

		if (editTool === 'junction') {
			session.addJunction(snapped.x, snapped.y);
			this.deps.refreshSchematicText(session);
			e.preventDefault();
			return true;
		}

		if (editTool === 'no-connect') {
			session.addNoConnect(snapped.x, snapped.y);
			this.deps.refreshSchematicText(session);
			e.preventDefault();
			return true;
		}

		if (editTool === 'place-symbol') {
			if (e.button === 0) {
				this.deps.placeSymbolAt(snapped);
			}
			e.preventDefault();
			return true;
		}

		if (editTool === 'image') {
			this.deps.tryPlacePendingImage(snapped);
			e.preventDefault();
			return true;
		}

		if (editTool === 'line' || editTool === 'rect' || editTool === 'circle' || editTool === 'text-box') {
			const shapeAnchor = this.deps.getShapeAnchor();
			if (!shapeAnchor) {
				this.deps.setShapeAnchor(snapped);
			}
			else if (samePoint(snapped, shapeAnchor)) {
				this.deps.setShapeAnchor(null);
				session.setEditPreview(null);
			}
			else {
				if (editTool === 'text-box') {
					const anchor = shapeAnchor;
					this.deps.setShapeAnchor(null);
					this.deps.showTextBoxInput(anchor, snapped, e);
				}
				else if (editTool === 'line') {
					session.addGraphicLine(shapeAnchor.x, shapeAnchor.y, snapped.x, snapped.y);
				}
				else if (editTool === 'rect') {
					session.addGraphicRect(shapeAnchor.x, shapeAnchor.y, snapped.x, snapped.y);
				}
				else {
					const radius = Math.hypot(snapped.x - shapeAnchor.x, snapped.y - shapeAnchor.y);
					session.addGraphicCircle(shapeAnchor.x, shapeAnchor.y, radius);
				}
				this.deps.refreshSchematicText(session);
				this.deps.setShapeAnchor(null);
				session.setEditPreview(null);
			}
			e.preventDefault();
			return true;
		}

		if (editTool === 'table') {
			this.deps.showTableModal(snapped);
			e.preventDefault();
			return true;
		}

		if (editTool === 'arc') {
			const arcPoints = this.deps.getArcPoints();
			if (arcPoints.length === 0) {
				this.deps.setArcPoints([snapped]);
			}
			else if (arcPoints.length === 1) {
				if (samePoint(snapped, arcPoints[0]!)) {
					this.deps.setArcPoints([]);
					session.setEditPreview(null);
				}
				else {
					this.deps.setArcPoints([arcPoints[0]!, snapped]);
				}
			}
			else {
				const [start, end] = arcPoints;
				session.addGraphicArc(start!.x, start!.y, snapped.x, snapped.y, end!.x, end!.y);
				this.deps.refreshSchematicText(session);
				this.deps.setArcPoints([]);
				session.setEditPreview(null);
			}
			e.preventDefault();
			return true;
		}

		if (editTool === 'bezier') {
			const bezierPoints = this.deps.getBezierPoints();
			if (bezierPoints.length < 4) {
				if (bezierPoints.length > 0 && samePoint(snapped, bezierPoints[bezierPoints.length - 1]!)) {
					this.deps.setBezierPoints([]);
					session.setEditPreview(null);
				}
				else {
					const nextBezierPoints = [...bezierPoints, snapped];
					this.deps.setBezierPoints(nextBezierPoints);
					if (nextBezierPoints.length === 4) {
						session.addGraphicBezier(nextBezierPoints.map(point => ({ x: point.x, y: point.y })));
						this.deps.refreshSchematicText(session);
						this.deps.setBezierPoints([]);
						session.setEditPreview(null);
					}
				}
			}
			e.preventDefault();
			return true;
		}

		if (editTool === 'rule-area') {
			const ruleAreaPoints = this.deps.getRuleAreaPoints();
			if (ruleAreaPoints.length >= 3 && samePoint(snapped, ruleAreaPoints[0]!)) {
				session.addRuleArea(ruleAreaPoints.map(point => ({ x: point.x, y: point.y })));
				this.deps.refreshSchematicText(session);
				this.deps.setRuleAreaPoints([]);
				session.setEditPreview(null);
			}
			else if (!ruleAreaPoints.length || !samePoint(snapped, ruleAreaPoints[ruleAreaPoints.length - 1]!)) {
				this.deps.setRuleAreaPoints([...ruleAreaPoints, snapped]);
			}
			e.preventDefault();
			return true;
		}

		if (editTool === 'power' && this.deps.getCurrentPowerKind() === 'rail') {
			this.deps.showTextInput(snapped, e);
			e.preventDefault();
			return true;
		}

		if (TEXT_INPUT_TOOLS.has(editTool)) {
			this.deps.showTextInput(snapped, e);
			e.preventDefault();
			return true;
		}

		if (editTool === 'power') {
			if (this.deps.getCurrentPowerKind() === 'gnd') {
				session.addPowerGnd(snapped.x, snapped.y);
				this.deps.setStatus('Added GND.');
			}
			else {
				session.addPowerFlag(snapped.x, snapped.y);
				this.deps.setStatus('Added PWR_FLAG.');
			}
			this.deps.refreshSchematicText(session);
			e.preventDefault();
			return true;
		}

		if (editTool === 'delete') {
			const hit = session.hitTestAtScreen(screenPos);
			if (hit) {
				if (hit.kind === 'symbol') {
					this.deps.setStatus('Symbols aren\'t deletable in edit mode.');
				}
				else {
					const removed = session.deleteElements([hit.id]);
					if (removed) {
						this.deps.refreshSchematicText(session);
						this.deps.setStatus('Deleted.');
					}
				}
			}
			e.preventDefault();
			return true;
		}

		return false;
	}

	protected onPointerMove(e: MouseEvent): void {
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		const activeGesture = this.deps.editGestureTracker.current;
		const pos = this.screenPosFromEvent(e);
		this.deps.runtime.lastPointerWorld = session.screenToWorld(pos);
		this.deps.updateStatusBar(pos);
		if (!this.deps.getHighlightNetEnabled()) {
			session.clearNetHighlight();
		}

		if (this.deps.getMode() === 'edit' && this.deps.getEditTool() !== 'select') {
			const worldPos = session.screenToWorld(pos);
			this.updateEditPreview(session, new Vec2(this.deps.snap(worldPos.x), this.deps.snap(worldPos.y)));
			return;
		}
		if (this.deps.getMode() === 'edit' && activeGesture.kind === 'curve') {
			const worldPos = session.screenToWorld(pos);
			if (session.moveCurveAnchorById(
				activeGesture.id, activeGesture.anchor, this.deps.snap(worldPos.x), this.deps.snap(worldPos.y))) {
				this.deps.runtime.dragMoved = true;
			}
			return;
		}
		if (this.deps.getMode() === 'edit' && activeGesture.kind === 'resize') {
			const worldPos = session.screenToWorld(pos);
			const bounds = this.resizedBoundsFromHandle(
				activeGesture.original, activeGesture.handle, new Vec2(this.deps.snap(worldPos.x), this.deps.snap(worldPos.y)));
			if (session.resizeElementBoundsById(
				activeGesture.id, bounds.x, bounds.y, bounds.width, bounds.height, activeGesture.handle)) {
				this.deps.runtime.dragMoved = true;
			}
			return;
		}
		if (this.deps.getMode() === 'edit' && activeGesture.kind === 'element') {
			const worldPos = session.screenToWorld(pos);
			const snapped = new Vec2(this.deps.snap(worldPos.x), this.deps.snap(worldPos.y));
			if (activeGesture.lastSnapped) {
				const dx = snapped.x - activeGesture.lastSnapped.x;
				const dy = snapped.y - activeGesture.lastSnapped.y;
				if (dx !== 0 || dy !== 0) {
					session.translateElementById(activeGesture.id, dx, dy);
					this.deps.editGestureTracker.update({ kind: 'element', id: activeGesture.id, lastSnapped: snapped });
					this.deps.runtime.dragMoved = true;
				}
			}
			return;
		}
		if (this.deps.getMode() === 'edit' && activeGesture.kind === 'rect-select') {
			const worldPos = session.screenToWorld(pos);
			if (!this.deps.runtime.dragMoved
				&& Math.hypot(pos.x - activeGesture.originScreen.x, pos.y - activeGesture.originScreen.y)
				> RECT_SELECT_MOVE_THRESHOLD_PX) {
				this.deps.runtime.dragMoved = true;
			}
			const boxMode: 'contained' | 'touching' = worldPos.x >= activeGesture.originWorld.x ? 'contained' : 'touching';
			session.setEditPreview({
				kind: 'selection-box',
				origin: activeGesture.originWorld,
				cursor: worldPos,
				mode: boxMode,
				selectMode: this.rectSelectionModeFromModifiers(e)
			});
			return;
		}
		if (this.deps.getMode() === 'edit' && activeGesture.kind === 'group') {
			const worldPos = session.screenToWorld(pos);
			const snapped = new Vec2(this.deps.snap(worldPos.x), this.deps.snap(worldPos.y));
			const dx = snapped.x - activeGesture.lastSnapped.x;
			const dy = snapped.y - activeGesture.lastSnapped.y;
			if (dx !== 0 || dy !== 0) {
				if (!this.deps.runtime.dragUndoCaptured) {
					session.pushUndoSnapshot('Group drag');
					this.deps.runtime.dragUndoCaptured = true;
				}
				session.translateSelection([...session.selectionIds], dx, dy);
				this.deps.editGestureTracker.update({ kind: 'group', lastSnapped: snapped });
				this.deps.runtime.dragMoved = true;
			}
			return;
		}
		if (activeGesture.kind === 'label') {
			const worldPos = session.screenToWorld(pos);
			const nx = this.deps.snap(worldPos.x - activeGesture.offset.x);
			const ny = this.deps.snap(worldPos.y - activeGesture.offset.y);
			if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
				this.deps.runtime.dragMoved = true;
			}
			session.moveLabelById(activeGesture.id, nx, ny, activeGesture.startPose.rotation);
			return;
		}
		if (activeGesture.kind === 'sheet') {
			const worldPos = session.screenToWorld(pos);
			const nx = this.deps.snap(worldPos.x - activeGesture.offset.x);
			const ny = this.deps.snap(worldPos.y - activeGesture.offset.y);
			if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
				this.deps.runtime.dragMoved = true;
			}
			if (this.deps.runtime.dragMoved && !this.deps.runtime.dragUndoCaptured) {
				session.pushUndoSnapshot('Sheet drag');
				this.deps.runtime.dragUndoCaptured = true;
			}
			session.moveSheetById(activeGesture.id, nx, ny);
			return;
		}
		if (activeGesture.kind === 'sheet-pin') {
			const worldPos = session.screenToWorld(pos);
			const nx = this.deps.snap(worldPos.x - activeGesture.offset.x);
			const ny = this.deps.snap(worldPos.y - activeGesture.offset.y);
			if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
				this.deps.runtime.dragMoved = true;
			}
			if (this.deps.runtime.dragMoved && !this.deps.runtime.dragUndoCaptured) {
				session.pushUndoSnapshot('Sheet pin drag');
				this.deps.runtime.dragUndoCaptured = true;
			}
			session.moveSheetPinById(activeGesture.id, nx, ny);
			return;
		}
		if (activeGesture.kind === 'symbol') {
			const worldPos = session.screenToWorld(pos);
			const nx = this.deps.snap(worldPos.x - activeGesture.offset.x);
			const ny = this.deps.snap(worldPos.y - activeGesture.offset.y);
			if (this.deps.getMode() === 'edit') {
				if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
					this.deps.runtime.dragMoved = true;
				}
				if (this.deps.runtime.dragMoved && !this.deps.runtime.dragUndoCaptured) {
					session.pushUndoSnapshot('Symbol drag');
					this.deps.runtime.dragUndoCaptured = true;
				}
				session.moveSymbolByRef(
					activeGesture.ref, nx, ny, activeGesture.startPose.rotation, activeGesture.instanceId ?? undefined);
				return;
			}
			const placement = this.deps.getPlacements().find((item: any) => item.ref === activeGesture.ref);
			if (!placement) {
				return;
			}
			placement.x = nx;
			placement.y = ny;
			if (this.deps.isEditablePowerPlacement(placement)) {
				placement.rotation = 0;
			}
			if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
				this.deps.runtime.dragMoved = true;
			}
			session.moveSymbolByRef(placement.ref, placement.x, placement.y, placement.rotation);
			return;
		}
		if (!this.deps.runtime.draggingPan) {
			return;
		}
		session.pan(pos.x - this.deps.runtime.dragStart.x, pos.y - this.deps.runtime.dragStart.y);
		this.deps.runtime.dragStart = pos;
	}

	protected onPointerUp(e: MouseEvent): void {
		const finishedGesture = this.deps.editGestureTracker.end();
		const moved = this.deps.runtime.dragMoved;
		const gestureKind = finishedGesture.kind;
		const isSymbolGesture = gestureKind === 'symbol';
		const isLabelGesture = gestureKind === 'label';
		const isElementGesture = gestureKind === 'element';
		const isResizeGesture = gestureKind === 'resize';
		const isCurveGesture = gestureKind === 'curve';
		const isSheetGesture = gestureKind === 'sheet';
		const isSheetPinGesture = gestureKind === 'sheet-pin';
		const rectGesture = finishedGesture.kind === 'rect-select'
			? { originWorld: finishedGesture.originWorld, originScreen: finishedGesture.originScreen }
			: null;
		const isRectGesture = !!rectGesture;
		const isGroupGesture = gestureKind === 'group';
		this.deps.runtime.draggingPan = false;

		const session = this.deps.getSession();
		if (this.deps.getMode() === 'circuit' && this.deps.getCircuitDragMode() && (isSymbolGesture || isLabelGesture) && moved) {
			void this.deps.commitReroute('autoroute');
		}
		else if (this.deps.getMode() === 'edit'
			&& (isSymbolGesture || isLabelGesture || isElementGesture || isResizeGesture || isCurveGesture
				|| isSheetGesture || isSheetPinGesture || isGroupGesture)
			&& moved && session) {
			if (isGroupGesture) {
				this.snapSelectionLabels(session);
			}
			this.deps.refreshSchematicText(session);
		}
		else if (this.deps.getMode() === 'edit' && isRectGesture && session) {
			if (moved) {
				const worldPos = session.screenToWorld(this.screenPosFromEvent(e));
				const boxMode: 'contained' | 'touching' = worldPos.x >= rectGesture!.originWorld.x ? 'contained' : 'touching';
				const hitIds = session.hitTestRect(rectGesture!.originWorld, worldPos, boxMode);
				session.selectMultiple(session.expandGroupSelection(hitIds), this.rectSelectionModeFromModifiers(e));
			}
			else if (!e.shiftKey && !e.ctrlKey) {
				session.select(null);
			}
			this.deps.syncSingleSelectionBookkeeping(session);
			session.setEditPreview(null);
			this.deps.dbg('rect-select commit', { moved, ids: [...session.selectionIds] });
		}
		this.deps.runtime.dragMoved = false;
		this.deps.runtime.dragUndoCaptured = false;
		this.deps.updateEditSidebar();
	}

	protected onDoubleClick(event: MouseEvent): void {
		if (this.deps.getMode() === 'view') {
			void this.deps.descendIntoSheetAtScreen(this.screenPosFromEvent(event));
			return;
		}
		if (this.deps.getMode() === 'edit' && this.deps.getEditTool() === 'rule-area' && this.deps.getRuleAreaPoints().length >= 3) {
			const session = this.deps.ensureSession();
			session.addRuleArea(this.deps.getRuleAreaPoints().map(point => ({ x: point.x, y: point.y })));
			this.deps.refreshSchematicText(session);
			this.deps.setRuleAreaPoints([]);
			session.setEditPreview(null);
			event.preventDefault();
			return;
		}
		if (this.deps.getMode() === 'edit' && this.deps.getEditTool() === 'select') {
			const hit = this.deps.ensureSession().hitTestAtScreen(this.screenPosFromEvent(event));
			if (hit?.kind === 'table') {
				this.deps.showTableEditModal(hit.id);
				event.preventDefault();
				return;
			}
			if (hit) {
				this.deps.showPropertiesModal(hit.id);
				event.preventDefault();
				return;
			}
		}
		if (this.deps.getMode() === 'edit' && (this.deps.getEditTool() === 'wire' || this.deps.getEditTool() === 'bus')
			&& this.deps.getLineChainStart()) {
			this.deps.setLineChainStart(null);
			this.deps.getSession()?.setEditPreview(null);
		}
	}

	protected screenPosFromEvent(e: MouseEvent): Vec2 {
		// .stage's rect, not the canvas's — see PointerControllerDeps.stage's
		// doc comment for why (canvas2d is display:none whenever WebGL is
		// active, and getBoundingClientRect() on it would be all zeros).
		const rect = this.deps.stage.getBoundingClientRect();
		const x = (e.clientX - rect.left) * (this.deps.canvas.width / Math.max(1, rect.width));
		const y = (e.clientY - rect.top) * (this.deps.canvas.height / Math.max(1, rect.height));
		return new Vec2(x, y);
	}

	protected rectSelectionModeFromModifiers(e: MouseEvent): 'replace' | 'add' | 'subtract' {
		if (e.shiftKey && e.ctrlKey) {
			return 'subtract';
		}
		if (e.shiftKey || e.ctrlKey) {
			return 'add';
		}
		return 'replace';
	}

	protected resizeHandleAtScreen(s: KicadRenderSession, screenPos: Vec2): {
		handle: ResizeHandle;
		box: SelectionResizeBox;
	} | null {
		const box = s.getSelectionResizeBox();
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
		for (let i = 0; i < points.length; i++) {
			const point = s.camera.worldToScreen(points[i]!);
			const distance = Math.hypot(point.x - screenPos.x, point.y - screenPos.y);
			if (distance <= hitRadius && (!closest || distance < closest.distance)) {
				closest = { handle: RESIZE_HANDLE_ORDER[i]!, distance };
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
		if (handle.includes('w')) {
			left = Math.min(cursor.x, right - grid);
		}
		if (handle.includes('e')) {
			right = Math.max(cursor.x, left + grid);
		}
		if (handle.includes('n')) {
			top = Math.min(cursor.y, bottom - grid);
		}
		if (handle.includes('s')) {
			bottom = Math.max(cursor.y, top + grid);
		}
		return { id: box.id, x: left, y: top, width: right - left, height: bottom - top };
	}

	protected curveAnchorAtScreen(s: KicadRenderSession, screenPos: Vec2): {
		anchor: CurveAnchor;
		curve: SelectionCurveAnchors;
	} | null {
		const curve = s.getSelectionCurveAnchors();
		if (!curve) {
			return null;
		}
		const hitRadius = 9 * (window.devicePixelRatio || 1);
		let closest: { anchor: CurveAnchor; distance: number } | null = null;
		for (const anchor of curve.anchors) {
			const point = s.camera.worldToScreen(new Vec2(anchor.x, anchor.y));
			const distance = Math.hypot(point.x - screenPos.x, point.y - screenPos.y);
			if (distance <= hitRadius && (!closest || distance < closest.distance)) {
				closest = { anchor: anchor.kind, distance };
			}
		}
		return closest ? { anchor: closest.anchor, curve } : null;
	}

	protected snapSelectionLabels(s: KicadRenderSession): void {
		for (const id of s.selectionIds) {
			const item = s.activeScene?.hitTestItems.find(candidate => candidate.id === id);
			if (item?.kind !== 'label' || item.labelKind === 'sheet-pin') {
				continue;
			}
			let origin: { x: number; y: number; rotation?: number } | null = null;
			if (item.labelKind === 'symbol-field' && item.fieldName) {
				const prop = (item.element as any)?.getPropertyByName?.(item.fieldName);
				origin = prop?.getOrigin?.() ?? null;
			}
			else {
				origin = (item.element as any)?.getOrigin?.() ?? null;
			}
			if (!origin) {
				continue;
			}
			const x = this.deps.snap(origin.x);
			const y = this.deps.snap(origin.y);
			if (x !== origin.x || y !== origin.y) {
				s.moveLabelById(id, x, y, origin.rotation);
			}
		}
	}

	protected beginSymbolDrag(ref: string, screenPos: Vec2): void {
		const session = this.deps.getSession();
		if (!this.deps.getCircuitDragMode() || !session) {
			return;
		}
		const placement = this.deps.ensurePlacement(ref);
		if (!placement) {
			this.deps.dbg('beginSymbolDrag failed', {
				ref,
				placementCount: this.deps.getPlacements().length,
				astPose: session.getSymbolPose(ref),
				listSample: session.listSymbolPoses().slice(0, 20)
			});
			this.deps.setStatus(`Selected ${ ref }, but AST has no pose for it — check console.`);
			return;
		}
		this.deps.dbg('beginSymbolDrag', placement);
		session.pushUndoSnapshot('Symbol drag');
		const world = session.screenToWorld(screenPos);
		const startPose = { x: placement.x, y: placement.y, rotation: placement.rotation };
		const offset = new Vec2(world.x - placement.x, world.y - placement.y);
		this.deps.runtime.dragMoved = false;
		this.deps.editGestureTracker.begin({ kind: 'symbol', ref, instanceId: null, offset, startPose });
	}

	protected beginEditSymbolDrag(ref: string, instanceId: string, screenPos: Vec2): void {
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		const pose = session.getSymbolPose(ref, instanceId);
		if (!pose) {
			return;
		}
		const world = session.screenToWorld(screenPos);
		const startPose = { x: pose.x, y: pose.y, rotation: pose.rotation };
		const offset = new Vec2(world.x - pose.x, world.y - pose.y);
		this.deps.runtime.dragMoved = false;
		this.deps.editGestureTracker.begin({ kind: 'symbol', ref, instanceId, offset, startPose });
	}

	protected beginSheetDrag(paintId: string, screenPos: Vec2): void {
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		const item = session.activeScene?.hitTestItems.find(it => it.id === paintId);
		const sheet = (item as { element?: any } | undefined)?.element;
		if (!sheet || typeof sheet.getPosition !== 'function') {
			return;
		}
		const pos = sheet.getPosition();
		const world = session.screenToWorld(screenPos);
		const startPose = { x: pos.x, y: pos.y, rotation: 0 };
		const offset = new Vec2(world.x - pos.x, world.y - pos.y);
		this.deps.runtime.dragMoved = false;
		this.deps.editGestureTracker.begin({ kind: 'sheet', id: paintId, offset, startPose });
	}

	protected beginSheetPinDrag(paintId: string, screenPos: Vec2): void {
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		const item = session.activeScene?.hitTestItems.find(it => it.id === paintId);
		const pin = (item as { element?: any } | undefined)?.element;
		if (!pin || typeof pin.getOrigin !== 'function') {
			return;
		}
		const pos = pin.getOrigin();
		const world = session.screenToWorld(screenPos);
		const startPose = { x: pos.x, y: pos.y, rotation: pos.rotation ?? 0 };
		const offset = new Vec2(world.x - pos.x, world.y - pos.y);
		this.deps.runtime.dragMoved = false;
		this.deps.editGestureTracker.begin({ kind: 'sheet-pin', id: paintId, offset, startPose });
	}
}
