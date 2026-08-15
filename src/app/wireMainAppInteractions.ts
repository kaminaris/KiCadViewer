import type { KicadRenderSession }                                       from '@kicad-render/KicadRenderSession';
import { Vec2 }                                                          from '@kicad-render/math/Vec2';
import { isEditablePowerPlacement }                                      from '@kicad-layout/index';
import type { AppMode }                                                  from './AppState';
import type { AppState }                                                 from './AppState';
import type { PendingShapeTracker }                                      from '../editor/PendingShape';
import type { EditGestureTracker }                                       from '../editor/EditGesture';
import type { Settings }                                                 from './Settings';
import type { SymbolChooser }                                            from '../ui/SymbolChooser';
import type { EditTool, PowerKind }                                      from '../editor/Toolbar';
import { TOOL_GROUPS }                                                    from '../editor/Toolbar';
import type { TextInputFlow }                                            from '../editor/TextInputFlow';
import { DIRECTIVE_LABEL_SHAPES, LABEL_SHAPES, TEXT_INPUT_PLACEHOLDERS } from '../editor/TextInputFlow';
import type { ContextMenu }                                              from '../editor/ContextMenu';
import type { ClipboardController }                                      from '../editor/ClipboardController';
import type { FileActions }                                              from '../io/FileActions';
import type { EditorRuntimeState }                                       from '../editor/EditorRuntimeState';
import { KeyboardController }                                            from '../editor/KeyboardController';
import type { PropertiesController }                                     from '../editor/PropertiesController';
import type { ToolStateController }                                      from '../editor/ToolStateController';
import { PointerController }                                             from '../editor/PointerController';
import { BoardPointerController }                                       from '../editor/BoardPointerController';
import { BoardToolbar }                                                 from '../editor/BoardToolbar';
import { BoardToggleToolbar }                                           from '../editor/BoardToggleToolbar';
import { ContextMenuController }                                         from '../editor/ContextMenuController';
import { runZoneFillJobs }                                               from '../worker/zoneFillClient';
import type { MainDomRefs }                                              from './domRefs';
import { runMainBootstrap }                                              from './bootstrap';
import type { SessionController }                                        from './SessionController';
import type { ActiveDocument }                                           from './ActiveDocument';

export interface WireMainAppInteractionsOptions {
	dom: MainDomRefs;
	settings: Settings;
	appState: AppState;
	doc: ActiveDocument;
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

	getHighlightNetEnabled(): boolean;

	setHighlightNetEnabled(enabled: boolean): void;

	getZoomStep(): number;

	getInvertZoom(): boolean;

	getCenterAndWarpCursorOnZoom(): boolean;

	getCurrentPowerKind(): PowerKind;

	getGridSpacingMm(): number;

	getBoardPolarCoordinates(): boolean;

	setBoardPolarCoordinates(enabled: boolean): void;

	getBoardDisplayUnit(): 'mm' | 'mil';

	setBoardDisplayUnit(unit: 'mm' | 'mil'): void;

	getBoardCrosshairMode(): 'small' | 'full' | 'diagonal';

	cycleBoardCrosshairMode(): void;

	getBoardRatsnestVisible(): boolean;

	setBoardRatsnestVisible(visible: boolean): void;

	getBoardZoneDisplayMode(): 'filled' | 'outline';

	setBoardZoneDisplayMode(mode: 'filled' | 'outline'): void;

	isBoardHighContrast(): boolean;

	cycleBoardHighContrastMode(): void;

	getBoardPadDisplayMode(): 'filled' | 'outline';

	cycleBoardPadDisplayMode(): void;

	getBoardViaDisplayMode(): 'filled' | 'outline';

	cycleBoardViaDisplayMode(): void;

	getBoardTrackDisplayMode(): 'filled' | 'outline';

	cycleBoardTrackDisplayMode(): void;

	getBoardAppearanceVisible(): boolean;

	setBoardAppearanceVisible(visible: boolean): void;

	getBoardRoutingSizes(): { trackWidth: number; viaSize: number; viaDrill: number };

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
	refreshHint(): void;

	setStatus(message: string): void;

	dbg(...args: unknown[]): void;

	snap(value: number): number;

	loadDemo(): Promise<void>;

	openKiCadFile(file: File): Promise<void>;

	runPlace(): void;

	commitReroute(connectivity: 'autoroute' | 'clear-wires'): Promise<void>;

	downloadSchematic(): void;
	downloadCurrentDocument(): void;

	refreshSchematicText(session: KicadRenderSession): void;

	refreshBoardText(session: KicadRenderSession): void;

	chooseSymbolDirectory(): Promise<void>;

	indexFallbackDirectory(files: FileList): Promise<void>;

	refreshSymbolLibraryButton(): Promise<void>;

	/** Called after the in-editor "Open Project Folder" / "New Project" /
	 *  "Open .zip" toolbar buttons successfully open a project — keeps the
	 *  URL bar (and hence reload / copy-link) pointed at whatever project
	 *  is now actually on screen, matching what Home's equivalent actions
	 *  do via the router. See MainApp.ts's router wiring. */
	onProjectOpened(projectId: string): void;
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
			if (!before || !parent) {
				return;
			}
			const startY = event.clientY;
			const startHeight = before.getBoundingClientRect().height;
			const move = (mv: PointerEvent) => {
				const next = Math.max(60, Math.min(parent.clientHeight - 120, startHeight + mv.clientY - startY));
				before.style.flex = 'none';
				before.style.height = `${ next }px`;
			};
			const done = () => {
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', done);
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', done, { once: true });
		});
	}

	const screenPosFromEvent = (e: MouseEvent): Vec2 => {
		// .stage's rect, not the canvas's — canvas2d is display:none whenever
		// WebGL is the active backend, and getBoundingClientRect() on a
		// display:none element is all zeros. .stage is never hidden and both
		// canvases fill it exactly (inset:0), so its rect is always right;
		// .width/.height stay canvas2d's own backing-store pixels either way,
		// since resize() keeps both canvases' pixel dimensions in sync.
		const canvas = options.doc.canvas;
		const rect = options.dom.stage.getBoundingClientRect();
		const x = (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
		const y = (e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
		return new Vec2(x, y);
	};

	// No more View/Circuit/Edit switcher — modeViewBtn/modeCircuitBtn/
	// modeEditBtn are hidden internal-state markers now (see domRefs.ts),
	// not real buttons, so nothing click-wires them here anymore.

	options.dom.highlightNetButton.addEventListener('click', () => {
		options.setHighlightNetEnabled(!options.getHighlightNetEnabled());
	});

	options.dom.openProjectButton.addEventListener('click', () => {
		void options.sessionController.openProjectFolder().then(key => { if (key) options.onProjectOpened(key); });
	});
	options.dom.saveProjectButton.addEventListener('click', () => {
		void options.sessionController.saveProject();
	});
	options.dom.newProjectButton.addEventListener('click', () => {
		void options.sessionController.newProject().then(key => { if (key) options.onProjectOpened(key); });
	});
	options.dom.zipInput.addEventListener('change', e => {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (file) {
			void options.sessionController.openProjectZip(file).then(key => { if (key) options.onProjectOpened(key); });
		}
		(e.target as HTMLInputElement).value = '';
	});

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
	options.dom.exportEditButton.addEventListener('click', () => options.downloadCurrentDocument());
	options.dom.undoButton.addEventListener('click', () => void options.sessionController.undo());
	options.dom.redoButton.addEventListener('click', () => void options.sessionController.redo());
	for (const el of [options.doc.canvas, options.doc.canvasGl]) {
		el.addEventListener('wheel', e => {
			e.preventDefault();
			const zoomIn = options.getInvertZoom() ? e.deltaY > 0 : e.deltaY < 0;
			const step = options.getZoomStep();
			const session = options.sessionController.ensureSession();
			const factor = zoomIn ? step : 1 / step;
			if (options.getCenterAndWarpCursorOnZoom()) {
				// KiCad centers the view on the mouse before zooming, then warps
				// the pointer to the viewport center. Browser security forbids the
				// physical warp, but this preserves the matching camera behavior.
				session.centerOnScreenPoint(screenPosFromEvent(e));
				session.zoomBy(factor);
			}
			else {
				session.zoomByAt(factor, screenPosFromEvent(e));
			}
			options.updateStatusBar();
		}, { passive: false });
	}

	const schematicPointerController = new PointerController({
		canvas: options.doc.canvas,
		canvasGl: options.doc.canvasGl,
		stage: options.dom.stage,
		runtime: options.runtime,
		editGestureTracker: options.editGestureTracker,
		getSession: options.getSession,
		ensureSession: () => options.sessionController.ensureSession(),
		ensurePlacement: options.ensurePlacement,
		getMode: options.getMode,
		getCircuitDragMode: options.getCircuitDragMode,
		getEditTool: options.getEditTool,
		getHighlightNetEnabled: options.getHighlightNetEnabled,
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
		showTextInput: (worldAnchor, event) => options.textInputFlow.showText(
			worldAnchor, event, TEXT_INPUT_PLACEHOLDERS),
		showTextBoxInput: (first, second, event) => options.textInputFlow.showTextBox(first, second, event),
		placeSymbolAt: snapped => options.symbolChooser.placeAt(snapped),
		tryPlacePendingImage: snapped => options.fileActions.tryPlacePendingImage(snapped),
		setStatus: options.setStatus,
		showTableModal: anchor => options.textInputFlow.showTable(anchor),
		showTableEditModal: id => options.textInputFlow.showTableEditor(id),
		showPropertiesModal: id => options.propertiesController.showPropertiesModal(id),
		descendIntoSheetAtScreen: screenPos => options.sessionController.descendIntoSheetAtScreen(screenPos)
	});

	let boardToolbar: BoardToolbar;
	const boardPointerController = new BoardPointerController({
		canvas: options.doc.canvas,
		canvasGl: options.doc.canvasGl,
		screenPosFromEvent,
		getSession: options.getSession,
		getMode: options.getMode,
		getGridSpacingMm: options.getGridSpacingMm,
		snap: options.snap,
		updateStatusBar: options.updateStatusBar,
		refreshBoardText: options.refreshBoardText,
		getTool: () => options.doc.boardTool,
		setTool: tool => {
			options.doc.boardTool = tool;
			boardToolbar?.refresh();
			options.refreshHint();
		},
		getActiveLayer: () => options.doc.activeBoardLayer,
		setStatus: options.setStatus,
		refreshAppearance: options.updateEditSidebar,
		showPropertiesModal: id => options.propertiesController.showPropertiesModal(id),
		showTextInput: (anchor, event) => options.textInputFlow.showText(anchor, event, TEXT_INPUT_PLACEHOLDERS),
		showTextBoxInput: (first, second, event) => options.textInputFlow.showTextBox(first, second, event),
		getHighlightNetEnabled: options.getHighlightNetEnabled,
		getRoutingSizes: options.getBoardRoutingSizes
	});
	boardToolbar = new BoardToolbar({
		getActiveTool: () => options.doc.boardTool,
		onToolClick: tool => boardPointerController.setTool(tool)
	});
	new BoardToggleToolbar({
		getGridVisible: () => options.doc.boardGridVisible,
		setGridVisible: visible => {
			options.doc.boardGridVisible = visible;
			options.getSession()?.setGridVisible(visible);
			options.setStatus(`PCB grid ${ visible ? 'shown' : 'hidden' }.`);
		},
		getPolarCoordinates: options.getBoardPolarCoordinates,
		setPolarCoordinates: options.setBoardPolarCoordinates,
		getDisplayUnit: options.getBoardDisplayUnit,
		setDisplayUnit: options.setBoardDisplayUnit,
		getCrosshairMode: options.getBoardCrosshairMode,
		cycleCrosshairMode: options.cycleBoardCrosshairMode,
		getRatsnestVisible: options.getBoardRatsnestVisible,
		setRatsnestVisible: options.setBoardRatsnestVisible,
		getZoneDisplayMode: options.getBoardZoneDisplayMode,
		setZoneDisplayMode: options.setBoardZoneDisplayMode,
		isHighContrast: options.isBoardHighContrast,
		cycleHighContrastMode: options.cycleBoardHighContrastMode,
		getHighlightNetEnabled: options.getHighlightNetEnabled,
		setHighlightNetEnabled: options.setHighlightNetEnabled,
		getPadDisplayMode: options.getBoardPadDisplayMode,
		cyclePadDisplayMode: options.cycleBoardPadDisplayMode,
		getViaDisplayMode: options.getBoardViaDisplayMode,
		cycleViaDisplayMode: options.cycleBoardViaDisplayMode,
		getTrackDisplayMode: options.getBoardTrackDisplayMode,
		cycleTrackDisplayMode: options.cycleBoardTrackDisplayMode,
		getAppearanceVisible: options.getBoardAppearanceVisible,
		setAppearanceVisible: options.setBoardAppearanceVisible
	});

	new KeyboardController(() => options.settings.current.shortcuts, {
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
		performSave: () => options.sessionController.saveProject(),
		copySelection: session => {
			options.clipboardController.copySelection(
				session, options.clipboardController.copyableIds(session, [...session.selectionIds]));
		},
		cutSelection: session => options.clipboardController.cutSelection(session),
		pasteSelection: (session, world) => options.clipboardController.pasteAtWorld(session, world),
		duplicateSelection: session => options.clipboardController.duplicateSelectedElements(session),
		refreshSchematicText: options.refreshSchematicText,
		setStatus: options.setStatus,
		syncSingleSelectionBookkeeping: options.syncSingleSelectionBookkeeping,
		rotateSelected: () => options.sessionController.rotateSelected(),
		autoplaceSelectedFields: () => options.sessionController.tidySelectedFields(),
		setEditTool: tool => options.toolStateController.setEditTool(tool),
		startImageInsertion: () => options.fileActions.startImageInsertion(),
		refreshBoardText: options.refreshBoardText
		,getBoardTool: () => options.doc.boardTool
		,setBoardTool: tool => boardPointerController.setTool(tool)
		,finishBoardRoute: () => boardPointerController.finishRoute()
		,cancelBoardRoute: () => boardPointerController.cancelRoute()
		,finishBoardDrawing: () => boardPointerController.finishDrawing()
		,cancelBoardDrawing: () => boardPointerController.cancelDrawing()
		,placeBoardViaAtPointer: () => boardPointerController.placeViaAtLastPointer()
		,getActiveBoardLayer: () => options.doc.activeBoardLayer
		,setActiveBoardLayer: layer => {
			options.doc.activeBoardLayer = layer;
			options.updateEditSidebar();
			options.refreshHint();
			options.setStatus(`Active PCB layer: ${ layer }.`);
		}
		,getBoardCopperLayers: () => {
			const layers = options.getSession()?.activeScene?.layersPresent ?? [];
			return layers.filter(layer => layer.endsWith('.Cu'));
		}
		,refreshBoardUi: options.updateEditSidebar
		,beginSchematicMove: () => schematicPointerController.beginInteractiveMove()
		,hasSchematicMove: () => schematicPointerController.hasInteractiveMove()
		,finishSchematicMove: () => schematicPointerController.finishInteractiveMove()
		,cancelSchematicMove: () => schematicPointerController.cancelInteractiveMove()
		,nudgeSchematicMove: (dx, dy) => schematicPointerController.nudgeInteractiveMove(dx, dy)
		,beginBoardMove: () => boardPointerController.beginInteractiveMove()
		,hasBoardMove: () => boardPointerController.hasInteractiveMove()
		,finishBoardMove: () => boardPointerController.finishInteractiveMove()
		,cancelBoardMove: () => boardPointerController.cancelInteractiveMove()
		,nudgeBoardMove: (dx, dy) => boardPointerController.nudgeInteractiveMove(dx, dy)
	});

	new ContextMenuController({
		canvas: options.doc.canvas,
		canvasGl: options.doc.canvasGl,
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
		,refreshBoardUi: options.updateEditSidebar
	});

	options.dom.propertiesModalCloseButton?.addEventListener(
		'click', () => options.propertiesController.closePropertiesModal());
	window.addEventListener(
		'click', e => options.propertiesController.maybeClosePropertiesModalFromWindowClick(e.target));
	window.addEventListener('resize', () => options.sessionController.resizeCanvas());
	options.dom.stage.addEventListener('dragover', e => e.preventDefault());
	window.addEventListener('paste', event => { options.fileActions.handleWindowPaste(event); });
	options.dom.stage.addEventListener('drop', e => { options.fileActions.handleStageDrop(e); });

	// Edit menu's Fill/Unfill All Zones — a one-shot board action, not a
	// tool-activation, so it rides the same 'kionline:board-command' channel
	// BoardPointerController listens on (for drawing tools) as a second,
	// independent listener rather than overloading that if/else chain.
	window.addEventListener('kionline:board-command', event => {
		const command = (event as CustomEvent<string>).detail;
		if (command !== 'fill-all-zones' && command !== 'unfill-all-zones') {
			return;
		}
		const session = options.getSession();
		if (!session) {
			return;
		}

		if (command === 'unfill-all-zones') {
			// Cheap (just clearing an AST field) — no worker needed.
			const count = session.clearAllZoneFills();
			if (count > 0) {
				options.refreshBoardText(session);
				options.updateUndoStackPane();
				options.updateEditSidebar();
				options.setStatus(`Cleared fill on ${ count } zone(s).`);
			}
			return;
		}

		// Fill All Zones runs real Clipper2 boolean ops off the main thread
		// (see zoneFillClient.ts) — real KiCad shows a modeless progress
		// dialog for the same reason (this can take a few seconds on a
		// board with several zones), mirrored here with a small modal.
		const progressModal = document.getElementById('zone-fill-progress-modal');
		const progressFill = document.getElementById('zone-fill-progress-fill');
		const progressLabel = document.getElementById('zone-fill-progress-label');
		progressModal?.classList.remove('hidden');
		if (progressFill) progressFill.style.width = '0%';
		if (progressLabel) progressLabel.textContent = 'Starting…';

		// Real design-rule values from the board's own .kicad_pro, not a
		// guessed constant — see ZoneFillDesignSettings' doc comment. A
		// board opened without a project (single-file mode) has no
		// projectFile, so this falls through to fillAllZones' own
		// real-KiCad-stock-default fallback.
		const projectFile = options.doc.projectContext?.project.projectFile;
		const designSettings = projectFile ? {
			minClearanceMm: projectFile.getMinClearanceMm(),
			copperEdgeClearanceMm: projectFile.getCopperEdgeClearanceMm(),
			defaultNetClassClearanceMm: projectFile.getDefaultNetClassClearanceMm(),
		} : undefined;

		session.fillAllZones(runZoneFillJobs, (done, total) => {
			if (progressFill) progressFill.style.width = `${ total > 0 ? (done / total) * 100 : 100 }%`;
			if (progressLabel) progressLabel.textContent = `${ done } / ${ total }`;
		}, designSettings).then(count => {
			progressModal?.classList.add('hidden');
			if (count > 0) {
				options.refreshBoardText(session);
				options.updateUndoStackPane();
				options.updateEditSidebar();
				options.setStatus(`Filled ${ count } zone(s).`);
			}
		}).catch((err: unknown) => {
			progressModal?.classList.add('hidden');
			options.setStatus(`Zone fill failed: ${ err instanceof Error ? err.message : String(err) }`);
		});
	});

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
