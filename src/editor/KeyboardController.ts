import { Vec2 } from '@kicad-render/math/Vec2';
import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { AppMode } from '../app/AppState';
import { shortcutMatches, type ShortcutActionId, type ShortcutMap } from '../app/Shortcuts';
import type { EditTool } from './Toolbar';
import type { BoardTool } from './BoardToolbar';

export interface KeyboardControllerCallbacks {
	syncPendingShapeTracker(): void;
	getMode(): AppMode;
	isCircuitDragMode(): boolean;
	getSession(): KicadRenderSession | null;
	getEditTool(): EditTool;
	getLastPointerWorld(): Vec2 | null;
	getSymbolChooserOpen(): boolean;
	cancelSymbolPlacement(): void;
	getPropertiesModalOpen(): boolean;
	closePropertiesModal(): void;
	getContextMenuOpen(): boolean;
	closeContextMenu(): void;
	getPendingShapeActive(): boolean;
	resetEditToolState(): void;
	clearSelectedReference(): void;
	clearSelectionBookkeeping(): void;
	performUndo(): Promise<void>;
	performRedo(): Promise<void>;
	performSave(): Promise<void>;
	copySelection(session: KicadRenderSession): void;
	cutSelection(session: KicadRenderSession): void;
	pasteSelection(session: KicadRenderSession, world: Vec2): Promise<void>;
	duplicateSelection(session: KicadRenderSession): void;
	refreshSchematicText(session: KicadRenderSession): void;
	setStatus(message: string): void;
	syncSingleSelectionBookkeeping(session: KicadRenderSession): void;
	rotateSelected(): Promise<void>;
	autoplaceSelectedFields(): void;
	setEditTool(tool: EditTool): void;
	startImageInsertion(): void;
	refreshBoardText(session: KicadRenderSession): void;
	getBoardTool(): BoardTool;
	setBoardTool(tool: BoardTool): void;
	finishBoardRoute(): boolean;
	cancelBoardRoute(): boolean;
	finishBoardDrawing(): boolean;
	cancelBoardDrawing(): boolean;
	placeBoardViaAtPointer(): boolean;
	getActiveBoardLayer(): string;
	setActiveBoardLayer(layer: string): void;
	getBoardCopperLayers(): string[];
	getOverrideLocks(): boolean;
	/** Real KiCad's "Select/Expand Connection" (U key) — see
	 *  KicadRenderSession.expandBoardConnection's own doc comment for the
	 *  3-tier junction/pad/whole-net escalation. */
	expandBoardConnection(): void;
	refreshBoardUi(): void;
	beginSchematicMove(): boolean;
	hasSchematicMove(): boolean;
	finishSchematicMove(): boolean;
	cancelSchematicMove(): Promise<boolean>;
	nudgeSchematicMove(dx: number, dy: number): boolean;
	beginBoardMove(): boolean;
	hasBoardMove(): boolean;
	finishBoardMove(): boolean;
	cancelBoardMove(): Promise<boolean>;
	nudgeBoardMove(dx: number, dy: number): boolean;
}

/** Owns global keyboard shortcuts for undo/redo, tools, and edit commands. */
export class KeyboardController {
	constructor(
		protected readonly getShortcuts: () => ShortcutMap,
		protected readonly cb: KeyboardControllerCallbacks
	) {
		window.addEventListener('keydown', event => this.onKeyDown(event));
	}

	protected onKeyDown(e: KeyboardEvent): void {
		this.cb.syncPendingShapeTracker();
		const target = e.target as HTMLElement | null;
		if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
			return;
		}

		if (this.matches(e, 'undo')) {
			e.preventDefault();
			void this.cb.performUndo();
			return;
		}
		if (this.matches(e, 'redo')) {
			e.preventDefault();
			void this.cb.performRedo();
			return;
		}
		if (this.matches(e, 'save')) {
			e.preventDefault();
			void this.cb.performSave();
			return;
		}
		if (this.matches(e, 'zoom-fit')) {
			e.preventDefault();
			this.cb.getSession()?.fitSchematicContent();
			return;
		}

		if (this.cb.getMode() === 'edit') {
			if (this.cb.getSession()?.documentTypeLoaded === 'board') {
				this.handleBoardEditModeKeyDown(e);
			}
			else {
				this.handleEditModeKeyDown(e);
			}
			return;
		}

		if (this.cb.getMode() !== 'circuit' || !this.cb.isCircuitDragMode()) {
			return;
		}
		if (e.key === 'Escape') {
			this.cb.clearSelectedReference();
			this.cb.getSession()?.select(null);
			return;
		}
		if (this.matches(e, 'rotate')) {
			e.preventDefault();
			void this.cb.rotateSelected();
		}
		if (this.matches(e, 'tidy')) {
			e.preventDefault();
			this.cb.autoplaceSelectedFields();
		}
	}

	protected handleEditModeKeyDown(e: KeyboardEvent): void {
		const session = this.cb.getSession();
		const editTool = this.cb.getEditTool();
		if (this.cb.hasSchematicMove()) {
			if (e.key === 'Escape') {
				e.preventDefault();
				void this.cb.cancelSchematicMove();
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				this.cb.finishSchematicMove();
				return;
			}
			const nudge = KeyboardController.nudgeForArrow(e.key);
			if (nudge) {
				e.preventDefault();
				this.cb.nudgeSchematicMove(nudge.x, nudge.y);
				return;
			}
		}
		if (this.matches(e, 'move') && this.cb.beginSchematicMove()) {
			e.preventDefault();
			return;
		}
		if (editTool === 'select' && session && this.matches(e, 'copy') && session.selectionIds.size > 0) {
			e.preventDefault();
			this.cb.copySelection(session);
			return;
		}
		if (editTool === 'select' && session && this.matches(e, 'cut') && session.selectionIds.size > 0) {
			e.preventDefault();
			this.cb.cutSelection(session);
			return;
		}
		if (editTool === 'select' && session && this.matches(e, 'paste')) {
			e.preventDefault();
			void this.cb.pasteSelection(
				session, this.cb.getLastPointerWorld() ?? new Vec2(session.camera.center.x, session.camera.center.y));
			return;
		}
		if (editTool === 'select' && session && this.matches(e, 'duplicate') && session.selectionIds.size > 0) {
			e.preventDefault();
			this.cb.duplicateSelection(session);
			return;
		}
		const hotkeyTool = this.toolForShortcut(e);
		if (hotkeyTool) {
			e.preventDefault();
			if (hotkeyTool === 'image') {
				this.cb.startImageInsertion();
			}
			else {
				this.cb.setEditTool(hotkeyTool);
			}
			return;
		}
		if (e.key === 'Escape') {
			if (this.cb.getSymbolChooserOpen() || editTool === 'place-symbol') {
				this.cb.cancelSymbolPlacement();
			}
			else if (this.cb.getPropertiesModalOpen()) {
				this.cb.closePropertiesModal();
			}
			else if (this.cb.getContextMenuOpen()) {
				this.cb.closeContextMenu();
			}
			else if (this.cb.getPendingShapeActive()) {
				this.cb.resetEditToolState();
			}
			else if (editTool !== 'select') {
				// A tool armed but with nothing clicked yet (no in-progress
				// gesture for getPendingShapeActive() to catch above) — real
				// KiCad's Escape always falls back to the Select tool here.
				this.cb.setEditTool('select');
			}
			else {
				this.cb.clearSelectionBookkeeping();
				session?.select(null);
			}
			return;
		}
		if (this.matches(e, 'delete') && editTool === 'select' && session
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			const hitItems = session.activeScene?.hitTestItems ?? [];
			const allIds = [...session.selectionIds];
			const deletableIds = allIds.filter(id => hitItems.find(it => it.id === id)?.kind !== 'symbol');
			const skippedSymbols = allIds.length - deletableIds.length;
			const removed = deletableIds.length ? session.deleteElements(deletableIds) : 0;
			if (removed) {
				this.cb.refreshSchematicText(session);
			}
			if (skippedSymbols && !removed) {
				this.cb.setStatus('Symbols aren\'t deletable in edit mode.');
			}
			else if (skippedSymbols) {
				this.cb.setStatus(
					`Deleted ${ removed } item(s); ${ skippedSymbols } symbol(s) skipped (not deletable in edit mode).`);
			}
			else if (removed) {
				this.cb.setStatus('Deleted.');
			}
			this.cb.syncSingleSelectionBookkeeping(session);
			return;
		}
		if (this.matches(e, 'rotate')) {
			e.preventDefault();
			void this.cb.rotateSelected();
			return;
		}
		if (this.matches(e, 'tidy')) {
			e.preventDefault();
			this.cb.autoplaceSelectedFields();
		}
	}

	/** Board-side counterpart to handleEditModeKeyDown — deliberately its
	 *  own small branch rather than threading board cases through the
	 *  schematic handler above (that one's `delete` case special-cases
	 *  symbols, calls refreshSchematicText, etc. — board wants none of
	 *  that). It covers selection transforms, BoardToolbar routing/via
	 *  activation, and copper-layer switching. Rotate/Flip act on whatever
	 *  BoardPointerController has selected, but currently only support a
	 *  single selection (session.selection is null for 0 or 2+) —
	 *  real KiCad rotates/flips a multi-selection as one group, which is a
	 *  reasonable future refinement, not attempted here. */
	protected handleBoardEditModeKeyDown(e: KeyboardEvent): void {
		const session = this.cb.getSession();
		if (!session) {
			return;
		}
		if (this.cb.hasBoardMove()) {
			if (e.key === 'Escape') {
				e.preventDefault();
				void this.cb.cancelBoardMove();
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				this.cb.finishBoardMove();
				return;
			}
			const nudge = KeyboardController.nudgeForArrow(e.key);
			if (nudge) {
				e.preventDefault();
				this.cb.nudgeBoardMove(nudge.x, nudge.y);
				return;
			}
		}
		if (this.matches(e, 'move') && this.cb.beginBoardMove()) {
			e.preventDefault();
			return;
		}
		if (e.key === 'Escape') {
			if (this.cb.cancelBoardRoute()) {
				e.preventDefault();
				return;
			}
			if (this.cb.cancelBoardDrawing()) {
				e.preventDefault();
				return;
			}
			if (this.cb.getBoardTool() !== 'select') {
				e.preventDefault();
				this.cb.setBoardTool('select');
				return;
			}
			session.select(null);
			return;
		}
		if (e.key === 'Enter' && this.cb.finishBoardRoute()) {
			e.preventDefault();
			return;
		}
		if (e.key === 'Enter' && this.cb.finishBoardDrawing()) {
			e.preventDefault();
			return;
		}
		// Pcbnew's default action hotkey for Place Text.
		if (e.key.toLowerCase() === 't' && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.cb.setBoardTool('text');
			return;
		}
		if (e.key.toLowerCase() === 'x' && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.cb.setBoardTool('route');
			return;
		}
		const graphicTool = ({ l: 'line', a: 'arc', c: 'circle', b: 'bezier' } as const)[e.key.toLowerCase()];
		if (graphicTool && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.cb.setBoardTool(graphicTool);
			return;
		}
		if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			if (this.cb.getBoardTool() === 'route') {
				if (this.cb.placeBoardViaAtPointer()) {
					this.cb.setActiveBoardLayer(this.oppositeBoardLayer());
				}
			}
			else {
				this.cb.setBoardTool('via');
			}
			return;
		}
		if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.cb.expandBoardConnection();
			return;
		}
		if (e.key === 'PageUp' || e.key === 'PageDown') {
			e.preventDefault();
			this.cb.setActiveBoardLayer(e.key === 'PageUp' ? 'F.Cu' : 'B.Cu');
			return;
		}
		if (e.key === '+' || e.key === '-' || e.key === '=') {
			const layers = this.cb.getBoardCopperLayers();
			if (layers.length) {
				e.preventDefault();
				const current = Math.max(0, layers.indexOf(this.cb.getActiveBoardLayer()));
				const delta = e.key === '-' ? -1 : 1;
				this.cb.setActiveBoardLayer(layers[(current + delta + layers.length) % layers.length]!);
			}
			return;
		}
		if (this.matches(e, 'delete') && session.selectionIds.size > 0) {
			e.preventDefault();
			const ids = [...session.selectionIds];
			// Simplified scope vs. real KiCad's per-item exclusion: refuse the
			// whole deletion if ANY selected item is locked, rather than
			// silently deleting everything else around it.
			if (!this.cb.getOverrideLocks() && ids.some(id => session.isBoardElementLocked(id))) {
				this.cb.setStatus('Locked item(s) in selection — enable "Override locks" to delete them.');
				return;
			}
			const removed = session.deleteElements(ids);
			if (removed) {
				this.cb.refreshBoardText(session);
				this.cb.refreshBoardUi();
				this.cb.setStatus(`Deleted ${ removed } item(s).`);
			}
			return;
		}
		if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && session.selection) {
			e.preventDefault();
			if (session.rotateFootprintByPaintId(session.selection, 90)) {
				this.cb.refreshBoardText(session);
				this.cb.refreshBoardUi();
			}
			return;
		}
		if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && session.selection) {
			e.preventDefault();
			if (session.flipFootprintByPaintId(session.selection)) {
				this.cb.refreshBoardText(session);
				this.cb.refreshBoardUi();
			}
		}
	}

	protected oppositeBoardLayer(): string {
		const current = this.cb.getActiveBoardLayer();
		return current === 'F.Cu' ? 'B.Cu' : 'F.Cu';
	}

	protected static nudgeForArrow(key: string): Vec2 | null {
		switch (key) {
			case 'ArrowLeft': return new Vec2(-1, 0);
			case 'ArrowRight': return new Vec2(1, 0);
			case 'ArrowUp': return new Vec2(0, -1);
			case 'ArrowDown': return new Vec2(0, 1);
			default: return null;
		}
	}

	protected matches(event: KeyboardEvent, action: ShortcutActionId): boolean {
		return shortcutMatches(event, this.getShortcuts()[action]);
	}

	protected toolForShortcut(event: KeyboardEvent): EditTool | null {
		const tools: Readonly<Record<ShortcutActionId, EditTool | null>> = {
			undo: null, redo: null, save: null, cut: null, copy: null, paste: null, duplicate: null, 'zoom-fit': null,
			move: null, rotate: null, tidy: null, select: 'select', 'place-symbol': 'place-symbol', power: 'power', wire: 'wire',
			bus: 'bus', 'bus-entry': 'bus-entry', 'no-connect': 'no-connect', junction: 'junction', label: 'label',
			'directive-label': 'directive-label', 'global-label': 'global-label', 'hier-label': 'hier-label',
			'rule-area': 'rule-area', text: 'text', 'text-box': 'text-box', table: 'table', line: 'line', rect: 'rect',
			circle: 'circle', arc: 'arc', bezier: 'bezier', image: 'image', delete: null
		};
		for (const [action, tool] of Object.entries(tools) as [ShortcutActionId, EditTool | null][]) {
			if (tool && this.matches(event, action)) {
				return tool;
			}
		}
		return null;
	}
}
