import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { Vec2 } from '@kicad-render/math/Vec2';
import { isEditablePowerPlacement } from '@kicad-layout/index';
import type { AppMode } from './AppState';
import type { AppState } from './AppState';
import type { PendingShapeTracker } from '../editor/PendingShape';
import type { EditGestureTracker } from '../editor/EditGesture';
import type { Settings } from './Settings';
import type { SymbolChooser } from '../ui/SymbolChooser';
import type { EditTool, PowerKind } from '../editor/Toolbar';
import { EDIT_TOOL_HOTKEYS, TOOL_GROUPS } from '../editor/Toolbar';
import type { TextInputFlow } from '../editor/TextInputFlow';
import { DIRECTIVE_LABEL_SHAPES, LABEL_SHAPES, TEXT_INPUT_PLACEHOLDERS } from '../editor/TextInputFlow';
import type { ContextMenu } from '../editor/ContextMenu';
import type { ClipboardController } from '../editor/ClipboardController';
import type { FileActions } from '../io/FileActions';
import type { EditorRuntimeState } from '../editor/EditorRuntimeState';
import { KeyboardController } from '../editor/KeyboardController';
import type { PropertiesController } from '../editor/PropertiesController';
import type { ToolStateController } from '../editor/ToolStateController';
import { PointerController } from '../editor/PointerController';
import { ContextMenuController } from '../editor/ContextMenuController';
import type { MainDomRefs } from './domRefs';
import { runMainBootstrap } from './bootstrap';
import type { SessionController } from './SessionController';

export interface WireMainAppInteractionsOptions {
	dom: MainDomRefs;
	settings: Settings;
	appState: AppState;
	runtime: EditorRuntimeState;
	pendingShapeTracker: PendingShapeTracker;
	editGestureTracker: EditGestureTracker;
	symbolChooser: SymbolChooser;
	editToolButtons: HTMLButtonElement[];
	textInputFlow: TextInputFlow;
	contextMenu: ContextMenu;
	clipboardController: ClipboardController;
	fileActions: FileActions;
	propertiesController: PropertiesController;
	toolStateController: ToolStateController;
	sessionController: SessionController;
	getSession(): KicadRenderSession | null;
	getMode(): AppMode;
	getCircuitDragMode(): boolean;
	getEditTool(): EditTool;
	getCurrentPowerKind(): PowerKind;
	getGridSpacingMm(): number;
	ensurePlacement(ref: string): any | null;
	getPlacements(): any[];
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
	getEditSelectedId(): string | null;
	setEditSelectedId(id: string | null): void;
	getEditSelectedKind(): string | null;
	setEditSelectedKind(kind: string | null): void;
	setSelectedRef(ref: string | null): void;
	clearSelectionBookkeeping(): void;
	syncPendingShapeTracker(): void;
	syncSingleSelectionBookkeeping(session: KicadRenderSession): void;
	updateStatusBar(screenPos?: Vec2): void;
	updateEditSidebar(): void;
	updateUndoStackPane(): void;
	setStatus(message: string): void;
	dbg(...args: unknown[]): void;
	snap(value: number): number;
	loadDemo(): Promise<void>;
	openKiCadFile(file: File): Promise<void>;
	runPlace(): void;
	commitReroute(connectivity: 'autoroute' | 'clear-wires'): Promise<void>;
	downloadSchematic(): void;
	refreshSchematicText(session: KicadRenderSession): void;
	chooseSymbolDirectory(): Promise<void>;
	indexFallbackDirectory(files: FileList): Promise<void>;
	refreshSymbolLibraryButton(): Promise<void>;
}

export function wireMainAppInteractions(options: WireMainAppInteractionsOptions): void {
	// Inspector controls must be interaction islands — pointer events must not
	// bubble to canvas drag-tracking listeners.
	for (const eventName of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick']) {
		options.dom.editPropertiesEl.addEventListener(eventName, event => event.stopPropagation());
		options.dom.propertiesModalEl.addEventListener(eventName, event => event.stopPropagation());
	}

	// Pane splitter drag resize.
	for (const splitter of options.dom.paneSplitters) {
		splitter.addEventListener('pointerdown', event => {
			event.preventDefault();
			const before = splitter.previousElementSibling as HTMLElement | null;
			const parent = splitter.parentElement;
			if (!before || !parent) return;
			const startY = event.clientY;
			const startHeight = before.getBoundingClientRect().height;
			const move = (mv: PointerEvent) => {
				const next = Math.max(60, Math.min(parent.clientHeight - 120, startHeight + mv.clientY - startY));
				before.style.flex = 'none';
				before.style.height = `${ next }px`;
			};
			const done = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', done); };
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', done, { once: true });
		});
	}

	const screenPosFromEvent = (e: MouseEvent): Vec2 => {
		const rect = options.dom.canvas.getBoundingClientRect();
		const x = (e.clientX - rect.left) * (options.dom.canvas.width / Math.max(1, rect.width));
		const y = (e.clientY - rect.top) * (options.dom.canvas.height / Math.max(1, rect.height));
		return new Vec2(x, y);
	};

	options.dom.modeViewBtn.addEventListener('click', () => options.sessionController.setMode('view'));
	options.dom.modeCircuitBtn.addEventListener('click', () => options.sessionController.setMode('circuit'));
	options.dom.modeEditBtn.addEventListener('click', () => options.sessionController.setMode('edit'));

	options.dom.fileInput.addEventListener('change', e => {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (file) {
			void options.openKiCadFile(file);
		}
	});

	options.dom.circuitFileInput.addEventListener('change', e => {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) {
			return;
		}
		if (options.getMode() !== 'circuit') {
			options.sessionController.setMode('circuit');
		}
		void options.openKiCadFile(file);
	});

	options.dom.demoButton.addEventListener('click', () => {
		void options.loadDemo().catch(err => options.setStatus(String(err)));
	});
	options.dom.imageInput.addEventListener('change', () => { void options.fileActions.handleImageInputChange(); });
	options.dom.indexSymbolsButton.addEventListener('click', () => { void options.chooseSymbolDirectory(); });
	options.dom.symbolDirectoryInput.addEventListener('change', () => {
		const files = options.dom.symbolDirectoryInput.files;
		if (files?.length) {
			void options.indexFallbackDirectory(files);
		}
	});

	options.dom.placeButton.addEventListener('click', () => options.runPlace());
	options.dom.autowireButton.addEventListener('click', () => {
		options.getSession()?.pushUndoSnapshot();
		void options.commitReroute('autoroute');
	});
	options.dom.clearWiresButton.addEventListener('click', () => {
		options.getSession()?.pushUndoSnapshot();
		void options.commitReroute('clear-wires');
	});
	options.dom.exportButton.addEventListener('click', () => options.downloadSchematic());
	options.dom.exportEditButton.addEventListener('click', () => options.downloadSchematic());
	options.dom.undoButton.addEventListener('click', () => void options.sessionController.undo());
	options.dom.redoButton.addEventListener('click', () => void options.sessionController.redo());
	options.dom.canvas.addEventListener('wheel', e => {
		e.preventDefault();
		options.sessionController.ensureSession().zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
		options.updateStatusBar();
	}, { passive: false });

	new PointerController({
		canvas: options.dom.canvas,
		runtime: options.runtime,
		editGestureTracker: options.editGestureTracker,
		getSession: options.getSession,
		ensureSession: () => options.sessionController.ensureSession(),
		ensurePlacement: options.ensurePlacement,
		getMode: options.getMode,
		getCircuitDragMode: options.getCircuitDragMode,
		getEditTool: options.getEditTool,
		getCurrentPowerKind: options.getCurrentPowerKind,
		getGridSpacingMm: options.getGridSpacingMm,
		getContextMenuOpen: () => options.contextMenu.isOpen,
		getPropertiesModalOpen: () => !options.dom.propertiesModalEl.classList.contains('hidden'),
		getSymbolChooserOpen: () => options.symbolChooser.isOpen,
		updateStatusBar: options.updateStatusBar,
		snap: options.snap,
		commitReroute: options.commitReroute,
		refreshSchematicText: options.refreshSchematicText,
		syncSingleSelectionBookkeeping: options.syncSingleSelectionBookkeeping,
		updateEditSidebar: options.updateEditSidebar,
		setSelectedRef: options.setSelectedRef,
		getEditSelectedId: options.getEditSelectedId,
		setEditSelectedId: options.setEditSelectedId,
		getEditSelectedKind: options.getEditSelectedKind,
		setEditSelectedKind: options.setEditSelectedKind,
		dbg: options.dbg,
		getPlacements: options.getPlacements,
		isEditablePowerPlacement,
		getRuleAreaPoints: options.getRuleAreaPoints,
		setRuleAreaPoints: options.setRuleAreaPoints,
		getLineChainStart: options.getLineChainStart,
		setLineChainStart: options.setLineChainStart,
		getShapeAnchor: options.getShapeAnchor,
		setShapeAnchor: options.setShapeAnchor,
		getArcPoints: options.getArcPoints,
		setArcPoints: options.setArcPoints,
		getBezierPoints: options.getBezierPoints,
		setBezierPoints: options.setBezierPoints,
		showTextInput: (worldAnchor, event) => options.textInputFlow.showText(worldAnchor, event, TEXT_INPUT_PLACEHOLDERS),
		showTextBoxInput: (first, second, event) => options.textInputFlow.showTextBox(first, second, event),
		placeSymbolAt: snapped => options.symbolChooser.placeAt(snapped),
		tryPlacePendingImage: snapped => options.fileActions.tryPlacePendingImage(snapped),
		setStatus: options.setStatus,
		showTableModal: anchor => options.textInputFlow.showTable(anchor),
		showTableEditModal: id => options.textInputFlow.showTableEditor(id),
		showPropertiesModal: id => options.propertiesController.showPropertiesModal(id)
	});

	new KeyboardController(EDIT_TOOL_HOTKEYS, {
		syncPendingShapeTracker: options.syncPendingShapeTracker,
		getMode: options.getMode,
		isCircuitDragMode: options.getCircuitDragMode,
		getSession: options.getSession,
		getEditTool: options.getEditTool,
		getLastPointerWorld: () => options.runtime.lastPointerWorld,
		getSymbolChooserOpen: () => options.symbolChooser.isOpen,
		cancelSymbolPlacement: () => options.symbolChooser.cancelPlacement(),
		getPropertiesModalOpen: () => !options.dom.propertiesModalEl.classList.contains('hidden'),
		closePropertiesModal: () => options.propertiesController.closePropertiesModal(),
		getContextMenuOpen: () => options.contextMenu.isOpen,
		closeContextMenu: () => options.contextMenu.close(),
		getPendingShapeActive: () => options.pendingShapeTracker.isActive,
		resetEditToolState: () => options.toolStateController.resetEditToolState(),
		clearSelectedReference: () => options.setSelectedRef(null),
		clearSelectionBookkeeping: options.clearSelectionBookkeeping,
		performUndo: () => options.sessionController.undo(),
		performRedo: () => options.sessionController.redo(),
		copySelection: session => {
			options.clipboardController.copySelection(session, options.clipboardController.copyableIds(session, [...session.selectionIds]));
		},
		cutSelection: session => options.clipboardController.cutSelection(session),
		pasteSelection: (session, world) => options.clipboardController.pasteAtWorld(session, world),
		duplicateSelection: session => options.clipboardController.duplicateSelectedElements(session),
		refreshSchematicText: options.refreshSchematicText,
		setStatus: options.setStatus,
		syncSingleSelectionBookkeeping: options.syncSingleSelectionBookkeeping,
		rotateSelected: () => options.sessionController.rotateSelected(),
		autoplaceSelectedFields: () => options.sessionController.tidySelectedFields(),
		setEditTool: tool => options.toolStateController.setEditTool(tool)
	});

	new ContextMenuController({
		canvas: options.dom.canvas,
		contextMenu: options.contextMenu,
		clipboardController: options.clipboardController,
		appState: options.appState,
		getSession: options.getSession,
		ensureSession: () => options.sessionController.ensureSession(),
		getMode: options.getMode,
		getEditTool: options.getEditTool,
		getPendingShapeActive: () => options.pendingShapeTracker.isActive,
		resetEditToolState: () => options.toolStateController.resetEditToolState(),
		syncPendingShapeTracker: options.syncPendingShapeTracker,
		screenPosFromEvent,
		getToolButtons: () => options.editToolButtons.map(
			button => ({ id: button.id, title: button.title, disabled: button.disabled, tool: button.dataset.tool })),
		toolGroups: TOOL_GROUPS,
		labelShapes: LABEL_SHAPES,
		directiveLabelShapes: DIRECTIVE_LABEL_SHAPES,
		setStatus: options.setStatus,
		updateUndoStackPane: options.updateUndoStackPane,
		groupSelectedElements: session => options.clipboardController.groupSelection(session),
		ungroupSelectedElements: session => options.clipboardController.ungroupSelection(session),
		setEditTool: tool => options.toolStateController.setEditTool(tool),
		startImageInsertion: () => options.fileActions.startImageInsertion(),
		setSelectedRef: options.setSelectedRef,
		rotateSelected: () => options.sessionController.rotateSelected(),
		autoplaceSelectedFields: () => options.sessionController.tidySelectedFields(),
		showEditLabelInput: id => options.textInputFlow.showEditLabel(id)
	});

	options.dom.propertiesModalCloseButton?.addEventListener('click', () => options.propertiesController.closePropertiesModal());
	window.addEventListener('click', e => options.propertiesController.maybeClosePropertiesModalFromWindowClick(e.target));
	window.addEventListener('resize', () => options.sessionController.resizeCanvas());
	options.dom.stage.addEventListener('dragover', e => e.preventDefault());
	window.addEventListener('paste', event => { options.fileActions.handleWindowPaste(event); });
	options.dom.stage.addEventListener('drop', e => { options.fileActions.handleStageDrop(e); });

	runMainBootstrap({
		dom: options.dom,
		settings: options.settings,
		setMode: mode => options.sessionController.setMode(mode),
		ensureSession: () => { options.sessionController.ensureSession(); },
		resizeCanvas: () => options.sessionController.resizeCanvas(),
		refreshSymbolLibraryButton: options.refreshSymbolLibraryButton,
		updateStatusBar: () => options.updateStatusBar()
	});
}
