import {
	KicadRenderSession,
	type KicadGlobalLabelShape,
	type KicadDirectiveLabelShape
}                                                                           from '@kicad-render/KicadRenderSession';
import { Vec2 }                                                             from '@kicad-render/math/Vec2';
import {
	wrapFullSchematic,
	type CircuitDesignRecipe,
	type CircuitPlacement
}                                                                           from '@kicad-layout/index';
import {
	SymbolLibraryCache
}                                                                           from '../io/SymbolLibraryCache';
import { StatusBar }                                                        from './StatusBar';
import { Settings }                                                        from './Settings';
import { AppState }                                                         from './AppState';
import { SessionController }                                                from './SessionController';
import { ActiveDocument }                                                   from './ActiveDocument';
import { ProjectRegistry }                                                  from './ProjectRegistry';
import { Router, type EditorView, type Route }                              from './Router';
import { HomeScreen }                                                       from '../ui/HomeScreen';
import { ProjectOverviewScreen }                                            from '../ui/ProjectOverviewScreen';
import { PreferencesDialog }                                                 from '../ui/PreferencesDialog';
import { BoardAppearancePanel }                                              from '../ui/BoardAppearancePanel';
import { SymbolChooser }                                                    from '../ui/SymbolChooser';
import {
	Toolbar,
	POWER_KIND_LABELS,
	type EditTool as ToolbarEditTool,
	type PowerKind
}                                                                           from '../editor/Toolbar';
import {
	TextInputFlow
}                                                                           from '../editor/TextInputFlow';
import { ContextMenu }                                                      from '../editor/ContextMenu';
import { PropertyPanel }                                                    from '../ui/PropertyPanel';
import { PropertyRenderers, MULTI_EDIT_NAMES as PROPERTY_MULTI_EDIT_NAMES } from '../ui/PropertyRenderers';
import { PropertyDialogRenderers }                                          from '../ui/PropertyDialogRenderers';
import { PendingShapeTracker }                                              from '../editor/PendingShape';
import { EditGestureTracker }                                               from '../editor/EditGesture';
import { PropertiesDialog }                                                 from '../ui/PropertiesDialog';
import { ClipboardController }                                              from '../editor/ClipboardController';
import { createMainDomRefs }                                                from './domRefs';
import { FileActions }                                                      from '../io/FileActions';
import { EditorRuntimeState }                                               from '../editor/EditorRuntimeState';
import { PropertiesController }                                             from '../editor/PropertiesController';
import { BoardPropertiesController }                                        from '../editor/BoardPropertiesController';
import { ToolStateController }                                              from '../editor/ToolStateController';
import { SymbolLibraryIndexer }                                             from '../io/SymbolLibraryIndexer';
import { wireMainAppInteractions }                                          from './wireMainAppInteractions';
import { MenuBar, wireToolbarCommandForwarding }                             from './MenuBar';
import { applySchematicTheme }                                                from './SchematicThemes';
import { ProjectSetupController }                                           from '../project-setup/ProjectSetupController';

type EditTool = ToolbarEditTool;

const statusBar = new StatusBar();

/** Safety net for failures outside the explicit try/catches (file loading,
 *  reroute, etc. already report their own status) — an unhandled error
 *  should never fail silently for someone who isn't watching devtools. The
 *  browser still logs the original error/stack to the console as usual. */
window.addEventListener('error', event => {
	statusBar.setStatus(`Unexpected error: ${ event.error instanceof Error ? event.error.message : event.message }`);
});
window.addEventListener('unhandledrejection', event => {
	const reason = event.reason;
	statusBar.setStatus(`Unexpected error: ${ reason instanceof Error ? reason.message : String(reason) }`);
});

const settings = new Settings();
settings.load();
applySchematicTheme(settings.current.schematicTheme, settings.current.schematicColorOverrides);
document.documentElement.dataset.theme = settings.current.theme;
document.documentElement.dataset.toolbarIconSize = settings.current.toolbarIconSize;
const dom = createMainDomRefs();
new MenuBar(document.getElementById('main-menu-bar') as HTMLElement);
wireToolbarCommandForwarding();

/** The single document this page load owns — see the harmonic-munching-
 *  trinket plan for why this collapsed from the earlier TabDocument/
 *  WorkspaceController pair (real "tabs" are now actual browser tabs,
 *  coordinated by a separate SharedWorker/IndexedDB layer, not an in-page
 *  list). Constructed this early because, unlike the old `workspace`, it
 *  has no dependency on anything defined further down the file. */
const doc = new ActiveDocument(dom.canvas, dom.canvasGl);
let activeEditorView: EditorView = doc.kind;

/** One shared instance — SessionController and the Home/Project screens all
 *  read/write the same IndexedDB-backed project list through it. */
const registry = new ProjectRegistry();

const propertyPanel = new PropertyPanel(dom.editPropertiesEl, dom.editUndoStackEl);
const propertyRenderers = new PropertyRenderers(propertyPanel, {
	getSession: () => doc.session,
	refreshSchematicText: activeSession => appState.refreshSchematicText(activeSession),
	refreshUndoStack: updateUndoStackPane
});
const propertiesDialog = new PropertiesDialog();
const propertyDialogRenderers = new PropertyDialogRenderers(propertiesDialog, {
	getSession: () => doc.session,
	mutateElement: id => makeElementMutator(id),
	mutateSymbol: id => makeSymbolMutator(id),
	mutateLibrary: id => fn => {
		if (!doc.session?.mutateLibSymbolForInstance(id, fn)) {
			return;
		}
		appState.refreshSchematicText(doc.session);
		updateUndoStackPane();
	},
	refresh: activeSession => appState.refreshSchematicText(activeSession),
	refreshUndo: updateUndoStackPane,
	show: hitId => propertiesController.showPropertiesModal(hitId)
});
const symbolLibraryCache = new SymbolLibraryCache();
const symbolLibraryIndexer = new SymbolLibraryIndexer(symbolLibraryCache, {
	setStatus,
	indexSymbolsButton: dom.indexSymbolsButton,
	symbolDirectoryInput: dom.symbolDirectoryInput
});

const appState = new AppState(doc);
const runtime = new EditorRuntimeState();
const boardProperties = new BoardPropertiesController({
	getSession: () => doc.session,
	panel: propertyPanel,
	dialog: propertiesDialog,
	refreshBoardText: activeSession => appState.refreshBoardText(activeSession),
	refreshUndo: updateUndoStackPane
});

const pendingShapeTracker = new PendingShapeTracker();
const editGestureTracker = new EditGestureTracker();

/** currentPowerKind is deliberately NOT per-document — one shared "last
 *  used power kind," seeded from and persisted to Settings. */
let currentPowerKind: PowerKind = settings.current.powerKind;

function syncPendingShapeTracker(): void {
	if (doc.lineChainStart) {
		pendingShapeTracker.set({ kind: 'chain', start: doc.lineChainStart });
	}
	else if (doc.shapeAnchor) {
		pendingShapeTracker.set({ kind: 'anchor', start: doc.shapeAnchor });
	}
	else if (doc.arcPoints.length) {
		pendingShapeTracker.set({ kind: 'arc', points: doc.arcPoints });
	}
	else if (doc.bezierPoints.length) {
		pendingShapeTracker.set({ kind: 'bezier', points: doc.bezierPoints });
	}
	else if (doc.ruleAreaPoints.length) {
		pendingShapeTracker.set({ kind: 'rule-area', points: doc.ruleAreaPoints });
	}
	else {
		pendingShapeTracker.clear();
	}
}

function setStatus(msg: string): void { statusBar.setStatus(msg); }

let propertiesController: PropertiesController;
let toolStateController: ToolStateController;
let boardAppearance: BoardAppearancePanel | null = null;

function updateEditSidebar(): void {
	propertiesController.updateEditSidebar();
	boardAppearance?.refresh();
}

function updateUndoStackPane(): void { propertiesController.updateUndoStackPane(); }

function makeSymbolMutator(id: string): (fn: (symbol: any) => void) => void {
	return fn => {
		if (!doc.session?.mutateSymbolByPaintId(id, fn)) {
			return;
		}
		appState.refreshSchematicText(doc.session);
		updateUndoStackPane();
	};
}

function makeElementMutator(id: string): (fn: (element: any) => void) => void {
	return fn => {
		if (!doc.session?.mutateElementByPaintId(id, fn)) {
			return;
		}
		appState.refreshSchematicText(doc.session);
		updateUndoStackPane();
	};
}

const SCHEMATIC_GRID_OPTIONS: ReadonlyArray<readonly [number, string]> = [
	[0.635, '0.635 mm (25 mil)'], [1.27, '1.27 mm (50 mil)'],
	[2.54, '2.54 mm (100 mil)'], [5.08, '5.08 mm (200 mil)']
];
const BOARD_GRID_OPTIONS: ReadonlyArray<readonly [number, string]> = [
	[0.05, '0.05 mm'], [0.1, '0.10 mm'], [0.2, '0.20 mm'],
	[0.25, '0.25 mm'], [0.5, '0.50 mm'], [1, '1.00 mm']
];

function snap(n: number): number { return settings.snap(n, doc.kind); }

function syncActiveGrid(): void {
	const board = doc.kind === 'board';
	const spacing = settings.gridSpacingFor(doc.kind);
	const presets = board ? BOARD_GRID_OPTIONS : SCHEMATIC_GRID_OPTIONS;
	dom.gridSelectEl.replaceChildren(...presets.map(([value, label]) => new Option(label, String(value), false, value === spacing)));
	dom.gridSelectEl.title = board ? 'PCB grid spacing' : 'Schematic grid spacing';
	dom.gridSelectEl.value = String(spacing);
	doc.session?.setGridSpacing(spacing);
	doc.session?.setGridVisible(doc.kind !== 'board' || doc.boardGridVisible);
	statusBar.setPolarCoordinates(doc.kind === 'board' && doc.boardPolarCoordinates);
}

function setGridSpacing(mm: number): void {
	settings.setGridSpacingMm(doc.kind, mm);
	doc.session?.setGridSpacing(mm);
}

function refreshCanvasCursor(): void {
	const cursor = doc.highlightNetEnabled || settings.current.crosshairCursor ? 'crosshair' : '';
	doc.canvas.style.cursor = cursor;
	doc.canvasGl.style.cursor = cursor;
}

function setHighlightNetEnabled(enabled: boolean): void {
	doc.highlightNetEnabled = enabled;
	dom.highlightNetButton.classList.toggle('active', enabled);
	dom.highlightNetButton.setAttribute('aria-pressed', String(enabled));
	dom.highlightNetButton.title = enabled ? 'Highlight Net (click a pin/label/wire to select the net)' :
		'Highlight Net';
	refreshCanvasCursor();
	if (!enabled) {
		doc.session?.clearNetHighlight();
		doc.session?.clearBoardNetHighlight();
	}
}

dom.gridSelectEl.addEventListener('change', () => {
	const mm = Number(dom.gridSelectEl.value);
	if (Number.isFinite(mm) && mm > 0) {
		setGridSpacing(mm);
	}
});

function updateStatusBar(screenPos?: Vec2): void {
	statusBar.updateCoordZoom(doc.session, screenPos);
}

function setBoardPolarCoordinates(enabled: boolean): void {
	doc.boardPolarCoordinates = enabled;
	statusBar.setPolarCoordinates(enabled);
	updateStatusBar();
	setStatus(`PCB coordinates: ${ enabled ? 'polar' : 'cartesian' }.`);
}

function updateSelectionStatus(): void {
	const activeSession = doc.session;
	if (!activeSession) {
		return;
	}
	const sole = activeSession.selection;
	if (!sole) {
		return;
	}
	const item = activeSession.activeScene?.hitTestItems.find(it => it.id === sole);
	if (!item || (item.kind !== 'wire' && item.kind !== 'bus')) {
		return;
	}
	const connectionName = activeSession.connectionNameForPaintId(sole);
	statusBar.setStatus(`Connection Name: ${ connectionName ?? '(unresolved)' }`);
}

const symbolChooser = new SymbolChooser(symbolLibraryCache, {
	getSession: () => doc.session,
	refreshSchematicText: activeSession => appState.refreshSchematicText(activeSession),
	setSelectedReference: reference => { doc.selectedRef = reference; },
	setStatus,
	setEditTool: tool => toolStateController.setEditTool(tool)
});
const contextMenu = new ContextMenu(dom.stage);

const textInputFlow = new TextInputFlow(appState, {
	getSession: () => doc.session,
	getTool: () => doc.editTool,
	getBoardTool: () => doc.boardTool,
	getActiveBoardLayer: () => doc.activeBoardLayer,
	getHitElement: id => (doc.session as any)?.schScene?.hitTestItems?.find(
		(item: any) => item.id === id)?.element,
	getLabelShape: () => doc.currentLabelShape,
	setLabelShape: shape => { doc.currentLabelShape = shape; },
	getDirectiveLabelShape: () => doc.currentDirectiveLabelShape,
	setDirectiveLabelShape: shape => { doc.currentDirectiveLabelShape = shape; },
	setStatus,
	updateHint: updateCircuitHint
});
const clipboardController = new ClipboardController(appState, {
	snap,
	syncSingleSelectionBookkeeping,
	refreshSidebar: updateEditSidebar,
	setStatus
});
const fileActions = new FileActions(dom.imageInput, {
	getMode: () => doc.mode,
	getSession: () => doc.session,
	getLastPointerWorld: () => runtime.lastPointerWorld,
	snap,
	setEditTool: tool => toolStateController.setEditTool(tool),
	setStatus,
	refreshSchematicText: activeSession => { appState.refreshSchematicText(activeSession); },
	setImageSelection: id => {
		doc.editSelectedId = id;
		doc.editSelectedKind = 'image';
	},
	refreshSidebar: updateEditSidebar,
	openKiCadFile: file => sessionController.openKiCadFile(file)
});
propertiesController = new PropertiesController({
	getSession: () => doc.session,
	getMode: () => doc.mode,
	editPropertiesEl: dom.editPropertiesEl,
	propertiesModalEl: dom.propertiesModalEl,
	propertyPanel,
	propertyRenderers,
	propertyDialogRenderers,
	propertiesDialog,
	multiEditNames: PROPERTY_MULTI_EDIT_NAMES,
	boardProperties
});
toolStateController = new ToolStateController({
	getSession: () => doc.session,
	getEditTool: () => doc.editTool,
	setEditToolValue: tool => { doc.editTool = tool; },
	clearSymbolPlacement: () => symbolChooser.clearPlacement(),
	clearLineChainStart: () => { doc.lineChainStart = null; },
	clearShapeAnchor: () => { doc.shapeAnchor = null; },
	clearArcPoints: () => { doc.arcPoints = []; },
	clearBezierPoints: () => { doc.bezierPoints = []; },
	clearRuleAreaPoints: () => { doc.ruleAreaPoints = []; },
	clearPendingShapeTracker: () => pendingShapeTracker.clear(),
	endGesture: () => { editGestureTracker.end(); },
	clearPendingTableState: () => {
		dom.tableModal.classList.add('hidden');
	},
	hidePropertiesModal: () => { propertiesController.closePropertiesModal(); },
	resetLabelShapes: () => {
		doc.currentLabelShape = 'input';
		doc.currentDirectiveLabelShape = 'round';
	},
	hideTextInput: () => { textInputFlow.reset(); },
	closeContextMenu: () => contextMenu.close(),
	syncToolbar: tool => toolbar.syncForTool(tool),
	syncToolButtons: tool => {
		for (const btn of editToolButtons) {
			btn.classList.toggle('active', btn.dataset.tool === tool);
		}
	},
	updateHint: updateCircuitHint,
	clearEditPreview: () => { doc.session?.setEditPreview(null); }
});

let sessionController: SessionController;
sessionController = new SessionController(doc, appState, settings, statusBar, dom, {
	closeSymbolChooser: () => symbolChooser.clearPlacement(),
	resetEditToolState: () => toolStateController.resetEditToolState(),
	refreshHint: updateCircuitHint,
	refreshSidebar: updateEditSidebar,
	clearLastPointer: () => { runtime.lastPointerWorld = null; },
	lockNetlistFromText: (text, force) => sessionController.lockNetlistFromText(text, force),
	syncPlacementsFromSession: () => sessionController.syncPlacementsFromSession(),
	canLockedAutoroute: () => sessionController.canLockedAutoroute(),
	relockNetlistFromLiveText: () => sessionController.relockNetlistFromLiveText(),
	restoreSelection: () => sessionController.restoreSelection(),
	ensurePlacement: ref => sessionController.ensurePlacement(ref),
	canAutoroute: () => sessionController.canAutoroute(),
	commitReroute: () => sessionController.commitReroute('autoroute'),
	refreshBreadcrumb: updateBreadcrumb,
	syncActiveGrid
}, registry);

const projectSetup = new ProjectSetupController(dom.projectSetupWorkspaceEl, {
	setStatus,
	onApplied: boardChanged => {
		// openFromRegistryRoute() treats navigating Project Setup → Board as a
		// no-op whenever doc.kind is already 'board' (its alreadyAtRoute check
		// short-circuits on `view === 'board'`), so a board-file-touching Apply
		// while the board tab was the one open before Project Setup would
		// otherwise leave the live scene showing the pre-Apply board until a
		// manual reopen. Reload it here instead; { preserveView: true } keeps
		// the existing camera/zoom instead of resetting it on every Apply.
		const board = doc.projectContext?.project.mainBoard;
		const reload = (boardChanged && doc.kind === 'board' && doc.session && board)
			? doc.session.loadBoardText(board.data, { preserveView: true })
			: Promise.resolve();
		void reload.then(() => {
			boardAppearance?.refresh();
			updateBreadcrumb();
		});
	}
});

boardAppearance = new BoardAppearancePanel(dom.boardAppearanceEl, {
	getSession: () => doc.session,
	setStatus,
	getActiveLayer: () => doc.activeBoardLayer,
	setActiveLayer: layer => { doc.activeBoardLayer = layer; }
});

/** Project / sheet name + Schematic|PCB tabs — replaced the old View/
 *  Circuit/Edit mode switcher (see the harmonic-munching-trinket plan).
 *  Hidden entirely outside a project (scratch/single-file mode has no
 *  companion view to switch to). */
function updateBreadcrumb(): void {
	const projectContext = doc.projectContext;
	if (!projectContext) {
		dom.breadcrumbEl.classList.add('hidden');
		dom.viewTabsEl.classList.add('hidden');
		return;
	}
	dom.breadcrumbEl.classList.remove('hidden');
	dom.viewTabsEl.classList.remove('hidden');
	dom.breadcrumbProjectEl.textContent = projectContext.rootName;
	dom.breadcrumbSheetEl.textContent = activeEditorView === 'project-settings'
		? 'Project Setup'
		: doc.kind === 'board'
		? 'PCB'
		: (doc.currentSheetNode?.name || projectContext.rootName);
	dom.viewTabSchematicBtn.classList.toggle('active', activeEditorView === 'schematic');
	dom.viewTabBoardBtn.classList.toggle('active', activeEditorView === 'board');
	dom.viewTabProjectSettingsBtn.classList.toggle('active', activeEditorView === 'project-settings');
	dom.viewTabBoardBtn.disabled = !projectContext.project.mainBoard;
}

function updateCircuitHint(): void {
	if (doc.kind === 'board') {
		statusBar.setHint(`PCB · ${ doc.boardTool } · active layer: ${ doc.activeBoardLayer } · X route · V via/switch layer · PgUp/PgDn front/back`);
		return;
	}
	const mode = doc.mode;
	const editTool = doc.editTool;
	if (mode === 'edit') {
		const shapeHint = (editTool === 'global-label' || editTool === 'hier-label')
			? ` · shape: ${ doc.currentLabelShape } (Tab to cycle)`
			: editTool === 'directive-label'
				? ` · shape: ${ doc.currentDirectiveLabelShape } (Tab to cycle)`
				: '';
		const groupHint = toolbar.findGroup(editTool) ? ' · right-click button to cycle label kind' : '';
		const powerHint = editTool === 'power'
			? ` · ${ POWER_KIND_LABELS[currentPowerKind] } (right-click button to cycle)`
			: '';
		statusBar.setHint(
			`Tool: ${ editTool }${ shapeHint }${ groupHint }${ powerHint } · S/W/J/X/L/C/A/G/H switch tools · `
			+ 'click to draw, wire chains until same-point/dblclick · '
			+ 'select: drag to move, Delete to remove, R rotate a symbol, T tidy labels · Esc cancel');
		return;
	}
	if (mode !== 'circuit') {
		statusBar.setHint('Wheel zoom · drag pan · open a local KiCad file');
		return;
	}
	const n = doc.placements.length;
	if (!n) {
		statusBar.setHint('Edit on · open a .kicad_sch (netlist locks on load for auto-rewire)');
		return;
	}
	if (sessionController.canLockedAutoroute()) {
		statusBar.setHint(
			`Edit on · ${ n } parts · drag / R rotate / T tidy labels · netlist locked · full rewire on drop`);
		return;
	}
	if (sessionController.canRecipeAutoroute()) {
		statusBar.setHint(`Edit on · ${ n } parts · drag / R · recipe rewire on drop`);
		return;
	}
	statusBar.setHint(`Edit on · ${ n } parts · drag / R (open a wired schematic to lock nets)`);
}

/** Re-derives editSelectedId/editSelectedKind/selectedRef from whatever
 *  session.selection resolves to after any multi-select-capable mutation
 *  (rect-select commit, a modifier-click, Delete on a multi-selection). The
 *  singular-degrade getter (null for 0 or 2+ selected) means a selection
 *  that happens to collapse to exactly one item re-arms Rotate/Tidy/Delete/
 *  the property sidebar for it automatically, with no special-casing —
 *  they already only ever look at these single-item variables. */
function syncSingleSelectionBookkeeping(s: KicadRenderSession): void {
	const sole = s.selection;
	const item = sole ? s.activeScene?.hitTestItems.find(it => it.id === sole) : undefined;
	doc.editSelectedId = sole;
	doc.editSelectedKind = item?.kind ?? null;
	doc.selectedRef = (item?.kind === 'symbol' && item.refDesignator) ? item.refDesignator : null;
	updateSelectionStatus();
	// Cross-tab selection sync (harmonic-munching-trinket plan Phase 7) — a
	// PCB tab on the same project outlines the matching footprint. No-op
	// outside a loaded project; refs=[] is still a meaningful publish (see
	// clearSelectionBookkeeping) when the schematic selection collapses to
	// nothing here (0 or 2+ items selected).
	sessionController.publishSelection(doc.selectedRef ? [doc.selectedRef] : []);
}

function clearSelectionBookkeeping(): void {
	doc.selectedRef = null;
	doc.editSelectedId = null;
	doc.editSelectedKind = null;
	sessionController.publishSelection([]);
}

const toolbar = new Toolbar(settings, {
	getActiveTool: () => doc.editTool,
	setActiveTool: tool => toolStateController.setEditTool(tool),
	onToolClick: tool => {
		if (tool === 'image') {
			fileActions.startImageInsertion();
		}
		else if (tool === 'place-symbol') {
			toolStateController.setEditTool('place-symbol');
			setStatus('Click on canvas to choose where to place a symbol.');
		}
		else {
			toolStateController.setEditTool(tool);
		}
	},
	onPowerKindChanged: () => {
		currentPowerKind = toolbar.powerKind;
		if (doc.editTool === 'power') {
			toolStateController.resetEditToolState();
			updateCircuitHint();
		}
	}
});
const editToolButtons = toolbar.buttons;

function applyPreferences(): void {
	document.documentElement.dataset.theme = settings.current.theme;
	document.documentElement.dataset.toolbarIconSize = settings.current.toolbarIconSize;
	applySchematicTheme(settings.current.schematicTheme, settings.current.schematicColorOverrides);
	doc.session?.refreshTheme();
	statusBar.setDisplayUnit(settings.current.displayUnit);
	document.querySelector<HTMLElement>('.status-bar')?.classList.toggle('hidden', !settings.current.showStatusBar);
	refreshCanvasCursor();
	syncActiveGrid();
	currentPowerKind = settings.current.powerKind;
	toolbar.setPowerKind(currentPowerKind);
	syncShortcutLabels();
	updateCircuitHint();
}

function syncShortcutLabels(): void {
	const actionsByTarget: Readonly<Record<string, string>> = {
		'btn-undo': 'undo', 'btn-redo': 'redo', 'btn-export-edit': '', 'btn-highlight-net': ''
	};
	for (const command of document.querySelectorAll<HTMLButtonElement>('.menu-command')) {
		const action = command.dataset.tool ?? command.dataset.shortcut ??
			(command.dataset.actionTarget ? actionsByTarget[command.dataset.actionTarget] : undefined);
		const binding = action ? (settings.current.shortcuts as Record<string, string>)[action] : undefined;
		const existing = command.querySelector('span');
		if (!binding) {
			existing?.remove();
			continue;
		}
		const label = existing ?? document.createElement('span');
		label.textContent = binding;
		if (!existing) {
			command.appendChild(label);
		}
	}
}

const preferencesDialog = new PreferencesDialog(settings, { applyPreferences });
syncShortcutLabels();
dom.preferencesButton.addEventListener('click', () => preferencesDialog.open());
window.addEventListener('keydown', event => {
	if ((event.ctrlKey || event.metaKey) && event.key === ',') {
		event.preventDefault();
		preferencesDialog.open();
	}
});

dom.recipeInput.addEventListener('change', async (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}
	doc.recipe = JSON.parse(await file.text()) as CircuitDesignRecipe;
	setStatus(`Recipe loaded (${ file.name }).`);
	updateCircuitHint();
});

dom.symbolInput.addEventListener('change', async (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}
	doc.icSymbolText = await file.text();
	setStatus(`Symbol loaded (${ file.name }).`);
	updateCircuitHint();
});

wireMainAppInteractions({
	dom,
	settings,
	appState,
	doc,
	runtime,
	pendingShapeTracker,
	editGestureTracker,
	symbolChooser,
	editToolButtons,
	textInputFlow,
	contextMenu,
	clipboardController,
	fileActions,
	propertiesController,
	toolStateController,
	sessionController,
	getSession: () => doc.session,
	getMode: () => doc.mode,
	getCircuitDragMode: () => doc.circuitDragMode,
	getEditTool: () => doc.editTool,
	getHighlightNetEnabled: () => doc.highlightNetEnabled,
	setHighlightNetEnabled,
	getZoomStep: () => ({ slow: 1.08, normal: 1.15, fast: 1.25 })[settings.current.zoomSpeed],
	getInvertZoom: () => settings.current.invertZoom,
	getCenterAndWarpCursorOnZoom: () => settings.current.centerAndWarpCursorOnZoom,
	getCurrentPowerKind: () => currentPowerKind,
	getGridSpacingMm: () => settings.gridSpacingFor(doc.kind),
	getBoardPolarCoordinates: () => doc.boardPolarCoordinates,
	setBoardPolarCoordinates,
	getBoardDisplayUnit: () => settings.current.displayUnit,
	setBoardDisplayUnit: unit => {
		settings.setDisplayUnit(unit);
		statusBar.setDisplayUnit(unit);
		updateStatusBar();
		setStatus(`Display units: ${ unit === 'mm' ? 'millimeters' : 'mils' }.`);
	},
	getBoardCrosshairMode: () => doc.session?.currentCrosshairMode ?? 'small',
	cycleBoardCrosshairMode: () => {
		const order = ['small', 'full', 'diagonal'] as const;
		const next = order[(order.indexOf(doc.session?.currentCrosshairMode ?? 'small') + 1) % order.length]!;
		doc.session?.setCrosshairMode(next);
		const label = next === 'small' ? 'small' : next === 'full' ? 'full-window' : '45-degree full-window';
		setStatus(`Crosshair: ${ label }.`);
	},
	getBoardRatsnestVisible: () => doc.session?.isRatsnestVisible ?? true,
	setBoardRatsnestVisible: visible => {
		doc.session?.setRatsnestVisible(visible);
		setStatus(`PCB ratsnest ${ visible ? 'shown' : 'hidden' }.`);
	},
	getBoardZoneDisplayMode: () => doc.session?.currentZoneDisplayMode ?? 'filled',
	setBoardZoneDisplayMode: mode => {
		doc.session?.setZoneDisplayMode(mode);
		setStatus(`PCB zones: ${ mode === 'filled' ? 'filled areas' : 'outlines only' }.`);
	},
	isBoardHighContrast: () => boardAppearance?.isHighContrast ?? false,
	cycleBoardHighContrastMode: () => {
		boardAppearance?.cycleHighContrastMode();
		setStatus(`Inactive layers: ${ boardAppearance?.isHighContrast ? 'high contrast' : 'normal' }.`);
	},
	getBoardPadDisplayMode: () => doc.session?.currentPadDisplayMode ?? 'filled',
	cycleBoardPadDisplayMode: () => {
		const next = doc.session?.currentPadDisplayMode === 'outline' ? 'filled' : 'outline';
		doc.session?.setPadDisplayMode(next);
		setStatus(`Pads: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' }.`);
	},
	getBoardViaDisplayMode: () => doc.session?.currentViaDisplayMode ?? 'filled',
	cycleBoardViaDisplayMode: () => {
		const next = doc.session?.currentViaDisplayMode === 'outline' ? 'filled' : 'outline';
		doc.session?.setViaDisplayMode(next);
		setStatus(`Vias: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' }.`);
	},
	getBoardTrackDisplayMode: () => doc.session?.currentTrackDisplayMode ?? 'filled',
	cycleBoardTrackDisplayMode: () => {
		const next = doc.session?.currentTrackDisplayMode === 'outline' ? 'filled' : 'outline';
		doc.session?.setTrackDisplayMode(next);
		setStatus(`Tracks: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' }.`);
	},
	getBoardAppearanceVisible: () => doc.boardAppearanceVisible,
	setBoardAppearanceVisible: visible => {
		doc.boardAppearanceVisible = visible;
		dom.boardAppearanceEl.classList.toggle('hidden', !visible);
		dom.mainEl.classList.toggle('board-appearance-hidden', !visible);
		// Toggling board-appearance-hidden changes #stage's column width in
		// the grid layout — resizeCanvas() must run AFTER that class change
		// takes effect, not before, or it bakes the PREVIOUS layout's width
		// into the WebGL canvas's backing store, which the browser then
		// stretches to fit the new (different) CSS box. Same root cause,
		// same fix, as setMode()'s identical board-appearance-hidden
		// toggle — see SessionController.loadText's comment on this.
		sessionController.resizeCanvas();
		setStatus(`PCB Appearance ${ visible ? 'shown' : 'hidden' }.`);
	},
	getBoardRoutingSizes: () => {
		const classes = doc.projectContext?.project.projectFile?.raw?.net_settings?.classes;
		const defaultClass = Array.isArray(classes)
			? (classes.find((item: any) => item?.name === 'Default') ?? classes[0])
			: null;
		return {
			trackWidth: Number(defaultClass?.track_width) || 0.25,
			viaSize: Number(defaultClass?.via_diameter) || 0.6,
			viaDrill: Number(defaultClass?.via_drill) || 0.3
		};
	},
	ensurePlacement: ref => sessionController.ensurePlacement(ref),
	getPlacements: () => doc.placements,
	getRuleAreaPoints: () => doc.ruleAreaPoints,
	setRuleAreaPoints: points => { doc.ruleAreaPoints = points; },
	getLineChainStart: () => doc.lineChainStart,
	setLineChainStart: value => { doc.lineChainStart = value; },
	getShapeAnchor: () => doc.shapeAnchor,
	setShapeAnchor: value => { doc.shapeAnchor = value; },
	getArcPoints: () => doc.arcPoints,
	setArcPoints: points => { doc.arcPoints = points; },
	getBezierPoints: () => doc.bezierPoints,
	setBezierPoints: points => { doc.bezierPoints = points; },
	getEditSelectedId: () => doc.editSelectedId,
	setEditSelectedId: id => { doc.editSelectedId = id; },
	getEditSelectedKind: () => doc.editSelectedKind,
	setEditSelectedKind: kind => { doc.editSelectedKind = kind; },
	setSelectedRef: ref => { doc.selectedRef = ref; },
	clearSelectionBookkeeping,
	syncPendingShapeTracker,
	syncSingleSelectionBookkeeping,
	updateStatusBar,
	updateEditSidebar,
	updateUndoStackPane,
	refreshHint: updateCircuitHint,
	setStatus,
	dbg: (...args) => statusBar.dbg(...args),
	snap,
	loadDemo: () => sessionController.loadDemo(),
	openKiCadFile: file => sessionController.openKiCadFile(file),
	runPlace: () => sessionController.runPlace(),
	commitReroute: connectivity => sessionController.commitReroute(connectivity),
	downloadSchematic: () => sessionController.downloadSchematic(
		doc.recipe?.ic.mpn || 'circuit', doc.placedFragment.trim() ? wrapFullSchematic(doc.placedFragment) : ''),
	downloadCurrentDocument: () => sessionController.downloadCurrentDocument(),
	refreshSchematicText: activeSession => { appState.refreshSchematicText(activeSession); },
	refreshBoardText: activeSession => { appState.refreshBoardText(activeSession); },
	chooseSymbolDirectory: () => symbolLibraryIndexer.chooseDirectory(),
	indexFallbackDirectory: files => symbolLibraryIndexer.indexFallbackDirectory(files),
	refreshSymbolLibraryButton: () => symbolLibraryIndexer.refreshButton(),
	onProjectOpened: projectId => router.navigate(
		{ screen: 'editor', projectId, view: 'schematic', sheet: null }, { replace: true })
});

/**
 * Router wiring — Home / Project overview / Editor are three sibling
 * `.screen` containers (see index.html), of which exactly one is visible at
 * a time; which one, and what the Editor screen shows, is entirely a
 * function of `router.route`. See the harmonic-munching-trinket plan's
 * Phase 2–4. Constructed last: everything it drives (sessionController,
 * doc, dom) already exists above.
 */
const router = new Router();

// Editor screen otherwise has no way back to Project overview / Home short
// of the browser's own back button (not discoverable, and a dead end for
// e.g. a zip-opened project reached via a fresh tab, which can't silently
// reopen itself the way a folder project can via requestPermission()).
dom.brandHomeButton.addEventListener('click', () => {
	if (activeEditorView === 'project-settings' && !projectSetup.requestLeave()) return;
	router.navigate(doc.projectContext ? { screen: 'project', projectId: doc.projectContext.key } : { screen: 'home' });
});

// Schematic/PCB view-switcher tabs — client-side navigation within the
// already-open project (no reload, unlike Project overview's "open in new
// tab"), replacing what used to require going back to Project overview.
dom.viewTabSchematicBtn.addEventListener('click', () => {
	if (!doc.projectContext || activeEditorView === 'schematic') {
		return;
	}
	if (activeEditorView === 'project-settings' && !projectSetup.requestLeave()) return;
	router.navigate({ screen: 'editor', projectId: doc.projectContext.key, view: 'schematic', sheet: null });
});
dom.viewTabBoardBtn.addEventListener('click', () => {
	if (!doc.projectContext || activeEditorView === 'board') {
		return;
	}
	if (activeEditorView === 'project-settings' && !projectSetup.requestLeave()) return;
	router.navigate({ screen: 'editor', projectId: doc.projectContext.key, view: 'board', sheet: null });
});
dom.viewTabProjectSettingsBtn.addEventListener('click', () => {
	if (!doc.projectContext || activeEditorView === 'project-settings') return;
	router.navigate({ screen: 'editor', projectId: doc.projectContext.key, view: 'project-settings', sheet: null });
});

const homeScreen = new HomeScreen(dom.screenHomeEl, registry, {
	openFolder: () => {
		void sessionController.openProjectFolder().then(key => {
			if (key) {
				router.navigate({ screen: 'editor', projectId: key, view: 'schematic', sheet: null });
			}
		});
	},
	newProject: () => {
		void sessionController.newProjectFolder().then(key => {
			if (key) {
				router.navigate({ screen: 'editor', projectId: key, view: 'schematic', sheet: null });
			}
		});
	},
	openZip: file => {
		void sessionController.openProjectZip(file).then(key => {
			if (key) {
				router.navigate({ screen: 'editor', projectId: key, view: 'schematic', sheet: null });
			}
		});
	},
	openProject: projectId => router.navigate({ screen: 'project', projectId }),
	openScratchEditor: () => router.navigate({ screen: 'editor', projectId: null, view: 'schematic', sheet: null })
});

const projectOverviewScreen = new ProjectOverviewScreen(dom.screenProjectEl, registry, {
	openView: (projectId, view) => router.navigate({ screen: 'editor', projectId, view, sheet: null }),
	openViewNewTab: (projectId, view) => {
		const params = new URLSearchParams({ project: projectId, view });
		window.open(`${ window.location.pathname }?${ params.toString() }`, '_blank');
	},
	back: () => router.navigate({ screen: 'home' })
});

function showScreen(name: Route['screen']): void {
	dom.screenHomeEl.classList.toggle('hidden', name !== 'home');
	dom.screenProjectEl.classList.toggle('hidden', name !== 'project');
	dom.screenEditorEl.classList.toggle('hidden', name !== 'editor');
}

async function applyRoute(route: Route): Promise<void> {
	if (route.screen === 'home') {
		showScreen('home');
		void homeScreen.refresh();
		return;
	}
	if (route.screen === 'project') {
		showScreen('project');
		void projectOverviewScreen.load(route.projectId);
		return;
	}
	// .stage is display:none until this line runs, so resizeCanvas() here
	// (before openFromRegistryRoute's own loadText → resizeCanvas call) is
	// what gives the canvas its real dimensions instead of the 1×1 fallback
	// a hidden element's clientWidth/clientHeight would otherwise produce.
	showScreen('editor');
	activeEditorView = route.view;
	const projectSetupActive = route.view === 'project-settings';
	dom.mainEl.classList.toggle('project-setup-mode', projectSetupActive);
	dom.screenEditorEl.dataset.documentKind = projectSetupActive ? 'project-settings' : route.view;
	if (!projectSetupActive) {
		projectSetup.deactivate();
		sessionController.resizeCanvas();
	}
	// projectId === null is the "scratch" editor (no project) — nothing to
	// load from the registry; the user picks a file via the editor's own
	// "Open .kicad_sch / .kicad_pcb" input, same as before project support
	// existed.
	if (route.projectId !== null) {
		if (projectSetupActive) {
			await sessionController.openFromRegistryRoute(route.projectId, doc.kind, doc.currentSheetNode?.path ?? null);
			if (doc.projectContext) {
				projectSetup.activate(doc.projectContext);
				updateBreadcrumb();
				statusBar.setHint('Project Setup · changes remain in a draft until Apply');
			}
		}
		else {
			await sessionController.openFromRegistryRoute(
				route.projectId,
				route.view as Exclude<EditorView, 'project-settings'>,
				route.sheet);
			updateBreadcrumb();
		}
	}
}

router.onChange(route => { void applyRoute(route); });
void applyRoute(router.route);
