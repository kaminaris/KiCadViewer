import { Vec2 } from '@kicad-render/math/Vec2';
import type {
	KicadGlobalLabelShape,
	KicadDirectiveLabelShape,
	KicadRenderSession
} from '@kicad-render/KicadRenderSession';
import type { ContextMenu } from '../ContextMenu';
import type { ClipboardController } from '../ClipboardController';
import type { AppState } from '../AppState';
import type { EditTool, ToolGroupDef } from '../Toolbar';

export interface ContextMenuControllerDeps {
	canvas: HTMLCanvasElement;
	contextMenu: ContextMenu;
	clipboardController: ClipboardController;
	appState: AppState;
	getSession(): KicadRenderSession | null;
	ensureSession(): KicadRenderSession;
	getMode(): string;
	getEditTool(): EditTool;
	getPendingShapeActive(): boolean;
	resetEditToolState(): void;
	syncPendingShapeTracker(): void;
	screenPosFromEvent(e: MouseEvent): Vec2;
	getToolButtons(): { id: string; title: string; disabled: boolean; tool: string | undefined }[];
	toolGroups: readonly ToolGroupDef[];
	labelShapes: readonly KicadGlobalLabelShape[];
	directiveLabelShapes: readonly KicadDirectiveLabelShape[];
	setStatus(message: string): void;
	updateUndoStackPane(): void;
	groupSelectedElements(session: KicadRenderSession): void;
	ungroupSelectedElements(session: KicadRenderSession): void;
	setEditTool(tool: EditTool): void;
	startImageInsertion(): void;
	setSelectedRef(ref: string | null): void;
	rotateSelected(): Promise<void>;
	autoplaceSelectedFields(): void;
	showEditLabelInput(id: string): void;
}

export class ContextMenuController {
	constructor(protected readonly deps: ContextMenuControllerDeps) {
		deps.canvas.addEventListener('contextmenu', e => this.onContextMenu(e));
	}

	protected onContextMenu(e: MouseEvent): void {
		if (this.deps.getMode() !== 'edit') {
			return;
		}
		e.preventDefault();
		this.deps.syncPendingShapeTracker();
		if (this.deps.getPendingShapeActive()) {
			this.deps.resetEditToolState();
			return;
		}
		const session = this.deps.ensureSession();
		const pointer = this.deps.screenPosFromEvent(e);
		const hit = session.hitTestAtScreen(pointer);
		const selectedIds = [...session.selectionIds];
		const items = this.deps.contextMenu.buildItems({
			session,
			hit,
			selectedIds,
			pointer: { x: pointer.x, y: pointer.y },
			screenToWorld: screen => session.screenToWorld(new Vec2(screen.x, screen.y)),
			toolButtons: this.deps.getToolButtons(),
			toolGroups: this.deps.toolGroups,
			labelShapes: this.deps.labelShapes,
			directiveLabelShapes: this.deps.directiveLabelShapes,
			actions: {
				zoomToSelection: s => {
					const selected = s.activeScene?.hitTestItems.filter(item => s.selectionIds.has(item.id)) ?? [];
					s.fitToItems(selected);
				},
				align: (s, ids, axis) => {
					if (s.alignSelection(ids, axis)) {
						this.deps.appState.refreshSchematicText(s);
						this.deps.updateUndoStackPane();
						this.deps.setStatus(`Aligned ${ ids.length } item(s).`);
					}
				},
				copy: (s, ids) => {
					this.deps.clipboardController.copySelection(s, this.deps.clipboardController.copyableIds(s, ids));
				},
				cut: s => this.deps.clipboardController.cutSelection(s),
				duplicate: s => this.deps.clipboardController.duplicateSelectedElements(s),
				group: s => this.deps.groupSelectedElements(s),
				ungroup: s => this.deps.ungroupSelectedElements(s),
				paste: (s, world) => {
					void this.deps.clipboardController.pasteAtWorld(s, new Vec2(world.x, world.y));
				},
				setTool: tool => this.deps.setEditTool(tool as EditTool),
				startImageInsertion: () => this.deps.startImageInsertion(),
				startSymbolPlacement: () => {
					this.deps.setEditTool('place-symbol');
					this.deps.setStatus('Click on canvas to choose where to place a symbol.');
				},
				rotate: (s, symbolHit) => {
					this.deps.setSelectedRef(symbolHit.refDesignator);
					s.select(symbolHit.id);
					void this.deps.rotateSelected();
				},
				tidyLabels: (s, symbolHit) => {
					this.deps.setSelectedRef(symbolHit.refDesignator);
					s.select(symbolHit.id);
					this.deps.autoplaceSelectedFields();
				},
				mirror: (s, id, axis) => {
					s.mutateSymbolByPaintId(id, symbol => { symbol.setMirror(symbol.getMirror() === axis ? null : axis); });
					this.deps.appState.refreshSchematicText(s);
				},
				delete: (s, id) => {
					if (s.deleteElements([id])) {
						this.deps.appState.refreshSchematicText(s);
						this.deps.setStatus('Deleted.');
					}
				},
				editLabel: id => this.deps.showEditLabelInput(id),
				cycleLabelShape: (s, labelHit, shapes) => {
					const element = (s as any).schScene?.hitTestItems?.find(
						(item: any) => item.id === labelHit.id)?.element;
					if (!element || typeof element.getShape !== 'function') return;
					const current = element.getShape();
					const next = shapes[(shapes.indexOf(current) + 1) % shapes.length]!;
					if (s.setLabelShape(labelHit.id, next as KicadGlobalLabelShape | KicadDirectiveLabelShape)) {
						this.deps.appState.refreshSchematicText(s);
						this.deps.setStatus(`Shape: ${ next }.`);
					}
				}
			}
		});
		this.deps.contextMenu.show(items, e.clientX, e.clientY);
	}
}
