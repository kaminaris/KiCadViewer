import { Vec2 } from '@kicad-render/math/Vec2';
import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { AppMode } from '../app/AppState';
import type { EditTool } from './Toolbar';

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
}

/** Owns global keyboard shortcuts for undo/redo, tools, and edit commands. */
export class KeyboardController {
	constructor(
		protected readonly hotkeys: Readonly<Record<string, EditTool>>,
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

		if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (e.shiftKey) {
				void this.cb.performRedo();
			}
			else {
				void this.cb.performUndo();
			}
			return;
		}
		if ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void this.cb.performRedo();
			return;
		}
		if (e.key === 'Home' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			this.cb.getSession()?.fitSchematicContent();
			return;
		}

		if (this.cb.getMode() === 'edit') {
			this.handleEditModeKeyDown(e);
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
		if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			void this.cb.rotateSelected();
		}
		if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.cb.autoplaceSelectedFields();
		}
	}

	protected handleEditModeKeyDown(e: KeyboardEvent): void {
		const session = this.cb.getSession();
		const editTool = this.cb.getEditTool();
		if (editTool === 'select' && session && (e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			this.cb.copySelection(session);
			return;
		}
		if (editTool === 'select' && session && (e.key === 'x' || e.key === 'X') && (e.ctrlKey || e.metaKey)
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			this.cb.cutSelection(session);
			return;
		}
		if (editTool === 'select' && session && (e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void this.cb.pasteSelection(
				session, this.cb.getLastPointerWorld() ?? new Vec2(session.camera.center.x, session.camera.center.y));
			return;
		}
		if (editTool === 'select' && session && (e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			this.cb.duplicateSelection(session);
			return;
		}
		const hotkeyTool = this.hotkeys[e.key.toLowerCase()];
		if (!e.ctrlKey && !e.metaKey && !e.altKey && hotkeyTool) {
			e.preventDefault();
			this.cb.setEditTool(hotkeyTool);
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
			else {
				this.cb.clearSelectionBookkeeping();
				session?.select(null);
			}
			return;
		}
		if ((e.key === 'Delete' || e.key === 'Backspace') && editTool === 'select' && session
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
		if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			void this.cb.rotateSelected();
			return;
		}
		if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.cb.autoplaceSelectedFields();
		}
	}
}
