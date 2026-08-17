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
import { FootprintLibraryCache }                                             from '../io/FootprintLibraryCache';
import { StatusBar }                                                        from './StatusBar';
import { Settings }                                                        from './Settings';
import { AppState }                                                         from './AppState';
import { SessionController }                                                from './SessionController';
import { ActiveDocument }                                                   from './ActiveDocument';
import { ProjectRegistry }                                                  from './ProjectRegistry';
import { Router, type EditorView, type Route }                              from './Router';
import { HomeScreen }                                                       from '../ui/HomeScreen';
import { ProjectOverviewScreen }                                            from '../ui/ProjectOverviewScreen';
import { SymbolEditorScreen }                                               from '../ui/SymbolEditorScreen';
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
import { FootprintLibraryIndexer }                                           from '../io/FootprintLibraryIndexer';
import { FootprintChooser }                                                  from '../ui/FootprintChooser';
import { SymbolFieldsTable }                                                 from '../ui/SymbolFieldsTable';
import { UpdatePcbFromSchematic }                                            from '../ui/UpdatePcbFromSchematic';
import { RouterSettingsDialog }                                              from '../ui/RouterSettingsDialog';
import { BoardAuxToolbar }                                                   from '../ui/BoardAuxToolbar';
import { LayerPairDialog }                                                   from '../ui/LayerPairDialog';
import { ZonePropertiesDialog }                                              from '../ui/ZonePropertiesDialog';
import { KicadBoard }                                                        from '@kicad-io/Project/KicadBoard';
import { resolveNetClass, buildNetClassRules, type NetClassRules }          from '@kicad-layout/NetClassResolver';
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

const footprintLibraryCache = new FootprintLibraryCache();
const footprintChooser = new FootprintChooser(footprintLibraryCache, { setStatus });
const footprintLibraryIndexer = new FootprintLibraryIndexer(footprintLibraryCache, {
	setStatus,
	indexFootprintsButton: dom.indexFootprintsButton,
	footprintDirectoryInput: dom.footprintDirectoryInput
});

const propertyPanel = new PropertyPanel(dom.editPropertiesEl, dom.editUndoStackEl);
const propertyRenderers = new PropertyRenderers(propertyPanel, {
	getSession: () => doc.session,
	refreshSchematicText: activeSession => appState.refreshSchematicText(activeSession),
	refreshUndoStack: updateUndoStackPane,
	refreshSidebar: updateEditSidebar,
	openFootprintChooser: context => footprintChooser.open(context)
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
	show: hitId => propertiesController.showPropertiesModal(hitId),
	openFootprintChooser: context => footprintChooser.open(context)
});
const symbolLibraryCache = new SymbolLibraryCache();
void symbolLibraryCache.ensureDefaultLibrary();
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
	refreshUndo: updateUndoStackPane,
	openZoneEditDialog: paintId => openZoneEditDialog(paintId)
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
let boardAuxToolbar: BoardAuxToolbar | null = null;

function updateEditSidebar(): void {
	propertiesController.updateEditSidebar();
	boardAppearance?.refresh();
	boardAuxToolbar?.refresh();
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
	},
	onCategoryChange: category => {
		if (!doc.projectContext) {
			return;
		}
		void navigateWithGuards({
			screen: 'editor',
			projectId: doc.projectContext.key,
			view: 'project-settings',
			sheet: null,
			category
		}, { replace: true });
	}
});

boardAppearance = new BoardAppearancePanel(dom.boardAppearanceEl, {
	getSession: () => doc.session,
	setStatus,
	getActiveLayer: () => doc.activeBoardLayer,
	setActiveLayer: layer => {
		doc.activeBoardLayer = layer;
		updateEditSidebar();
		setStatus(`Active PCB layer: ${ layer }.`);
	},
	onLayerStateChange: state => {
		// Persist per-layer visibility/opacity into the project's local settings
		const project = doc.projectContext?.project;
		if (!project || !project.localSettings) return;
		try {
			project.localSettings.setLayerState(state);
			// Save project in background — non-blocking UI
			void sessionController.saveProject();
			setStatus('Saved layer visibility.');
		}
		catch (err) {
			setStatus('Could not persist layer visibility.');
		}
	},
	onObjectsStateChange: state => {
		const project = doc.projectContext?.project;
		if (!project || !project.localSettings) return;
		try {
			if (state.visible_items) {
				project.localSettings.setBoardVisibleItems(state.visible_items);
			}
			if (state.opacity) {
				if (project.localSettings.parsed === null) project.localSettings.parsed = {};
				if (!project.localSettings.parsed.board) project.localSettings.parsed.board = {};
				if (!project.localSettings.parsed.board.opacity) project.localSettings.parsed.board.opacity = {};
				for (const [k, v] of Object.entries(state.opacity)) {
					(project.localSettings.parsed.board.opacity as Record<string, any>)[k] = v;
				}
			}
			if (state.displayModes) {
				const dm = state.displayModes as Record<string, string>;
				if (dm.tracks) project.localSettings.setTrackDisplayMode(dm.tracks as any);
				if (dm.vias) project.localSettings.setViaDisplayMode(dm.vias as any);
				if (dm.pads) project.localSettings.setPadDisplayMode(dm.pads as any);
				if (dm.zones) project.localSettings.setZoneDisplayMode(dm.zones as any);
			}
			void sessionController.saveProject();
			setStatus('Saved appearance settings.');
		}
		catch (err) { setStatus('Could not persist appearance settings.'); }
	}
});

function getBoardCopperLayers(): string[] {
	return (doc.session?.activeScene?.layersPresent ?? []).filter(layer => layer.endsWith('.Cu'));
}

const layerPairDialog = new LayerPairDialog({
	getBoardCopperLayers,
	getViaLayerPair: () => doc.viaLayerPair,
	setViaLayerPair: pair => {
		doc.viaLayerPair = pair;
		setStatus(`New vias will span ${ pair[0] } ↔ ${ pair[1] }.`);
	}
});

const zonePropertiesDialog = new ZonePropertiesDialog({
	getCopperLayers: getBoardCopperLayers,
	getNets: () => doc.session?.getBoardNets() ?? []
});

/** Zone AST create/update and the actual copper fill (real Clipper2 work,
 *  off-thread) are deliberately separate calls — see fillZone's own doc
 *  comment. Re-filling EVERY zone after touching just one (rather than a
 *  single-zone fillZone) matches real KiCad's own behavior: zone priority
 *  means one zone's outline/clearance change can shrink or grow a
 *  DIFFERENT zone's territory, so a full re-fill is the correct result here,
 *  not a shortcut — and it lets this reuse the exact same progress-modal +
 *  runZoneFillJobs flow the Fill All Zones menu command already owns
 *  (wireMainAppInteractions.ts's 'kionline:board-command' handler) instead
 *  of duplicating that plumbing. */
function commitZoneDraftAndRefill(action: () => string | null): void {
	const session = doc.session;
	if (!session || !action()) {
		return;
	}
	appState.refreshBoardText(session);
	updateUndoStackPane();
	updateEditSidebar();
	window.dispatchEvent(new CustomEvent<string>('kionline:board-command', { detail: 'fill-all-zones' }));
}

function openZoneDialogForOutline(points: Vec2[]): void {
	const session = doc.session;
	if (!session) {
		return;
	}
	const copperLayers = getBoardCopperLayers();
	const draft = {
		...ZonePropertiesDialog.blankDraft(),
		layers: copperLayers.includes(doc.activeBoardLayer) ? [doc.activeBoardLayer] : copperLayers.slice(0, 1)
	};
	zonePropertiesDialog.open(draft, committed => {
		commitZoneDraftAndRefill(() => session.createZoneFromOutline(points, committed));
	});
}

function openZoneEditDialog(paintId: string): void {
	const session = doc.session;
	const draft = session?.getZoneDraft(paintId);
	if (!session || !draft) {
		return;
	}
	zonePropertiesDialog.open(draft, committed => {
		commitZoneDraftAndRefill(() => (session.updateZoneProperties(paintId, committed) ? paintId : null));
	});
}

boardAuxToolbar = new BoardAuxToolbar({
	getProjectRaw: () => doc.projectContext?.project.projectFile?.raw,
	getTrackWidthIndex: () => doc.trackWidthIndex,
	setTrackWidthIndex: index => { doc.trackWidthIndex = index; boardAuxToolbar?.refresh(); },
	getViaSizeIndex: () => doc.viaSizeIndex,
	setViaSizeIndex: index => { doc.viaSizeIndex = index; boardAuxToolbar?.refresh(); },
	getUseConnectedTrackWidth: () => doc.useConnectedTrackWidth,
	setUseConnectedTrackWidth: value => { doc.useConnectedTrackWidth = value; },
	getActiveBoardLayer: () => doc.activeBoardLayer,
	setActiveBoardLayer: layer => {
		doc.activeBoardLayer = layer;
		updateEditSidebar();
		setStatus(`Active PCB layer: ${ layer }.`);
	},
	getBoardCopperLayers,
	getOverrideLocks: () => doc.overrideLocks,
	setOverrideLocks: value => { doc.overrideLocks = value; },
	openLayerPairDialog: () => layerPairDialog.open(),
	openProjectSetup: (category?: string) => {
		if (!doc.projectContext) {
			return;
		}
		void navigateWithGuards({ screen: 'editor', projectId: doc.projectContext.key, view: 'project-settings', sheet: null, category: category ?? null });
	}
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
	updateDirtyIndicators();
	dom.viewTabSchematicBtn.classList.toggle('active', activeEditorView === 'schematic');
	dom.viewTabBoardBtn.classList.toggle('active', activeEditorView === 'board');
	dom.viewTabProjectSettingsBtn.classList.toggle('active', activeEditorView === 'project-settings');
	dom.viewTabBoardBtn.disabled = !projectContext.project.mainBoard;
}

function updateDirtyIndicators(): void {
	const schematicDirty = doc.hasUnsavedSchematicChanges;
	const boardDirty = doc.hasUnsavedBoardChanges;
	const schematicViewActive = activeEditorView === 'schematic' && doc.kind === 'schematic';
	const boardViewActive = activeEditorView === 'board' && doc.kind === 'board';
	dom.saveProjectButton.classList.toggle('dirty', (schematicViewActive && schematicDirty) || (boardViewActive && boardDirty));
	const baseSheetLabel = activeEditorView === 'project-settings'
		? 'Project Setup'
		: doc.kind === 'board'
			? 'PCB'
			: (doc.currentSheetNode?.name || doc.projectContext?.rootName || 'Schematic');
	const modified = (schematicViewActive && schematicDirty) || (boardViewActive && boardDirty);
	dom.breadcrumbSheetEl.classList.toggle('modified', modified);
	dom.breadcrumbSheetEl.textContent = modified
		? `${ baseSheetLabel } *`
		: baseSheetLabel;
	document.title = modified ? '* KiOnline' : 'KiOnline';
}

appState.setTextChangedHandler(() => updateDirtyIndicators());
updateDirtyIndicators();

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
		'btn-undo': 'undo', 'btn-redo': 'redo', 'btn-save-project': 'save',
		'btn-export-edit': '', 'btn-highlight-net': ''
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
		return;
	}
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && router.route.screen === 'symbol') {
		event.preventDefault();
		void symbolEditorScreen.save();
	}
});

const symbolFieldsTable = new SymbolFieldsTable({
	setStatus,
	getSession: () => doc.session,
	getProjectContext: () => doc.projectContext,
	getCurrentSheetNode: () => doc.currentSheetNode,
	saveProject: () => sessionController.saveProject(),
	refreshSidebar: updateEditSidebar,
	openFootprintChooser: context => footprintChooser.open(context)
});
dom.symbolFieldsTableButton.addEventListener('click', () => symbolFieldsTable.open());

const updatePcbFromSchematic = new UpdatePcbFromSchematic(footprintLibraryCache, {
	setStatus,
	getSession: () => doc.session,
	getProjectContext: () => doc.projectContext,
	getCurrentSheetNode: () => doc.currentSheetNode,
	saveProject: () => sessionController.saveProject(),
	refreshSidebar: updateEditSidebar
});
dom.updatePcbFromSchematicButton.addEventListener('click', () => updatePcbFromSchematic.open());

const routerSettingsDialog = new RouterSettingsDialog({
	getRouterSettings: () => doc.routerSettings,
	setRouterSettings: settings => { doc.routerSettings = settings; }
});
dom.routerSettingsButton.addEventListener('click', () => routerSettingsDialog.open());

// Board Tools menu's "Recreate PCB…" — rides the same 'kionline:board-
// command' channel as the Edit menu's Fill/Unfill All Zones (see
// wireMainAppInteractions.ts's identical pattern/comment); kept as its own
// listener here instead since this needs doc/sessionController directly.
// Wipes every footprint/track/via/zone/net and replaces the board's AST
// with a fresh KicadBoard.createBlank() — the same generator "New Project"
// uses — so a board that's accumulated stale/inconsistent net data (e.g.
// from before a net-assignment bug fix) can be regenerated cleanly via
// "Update PCB from Schematic" instead of hand-fixing every footprint.
window.addEventListener('kionline:board-command', event => {
	const command = (event as CustomEvent<string>).detail;
	if (command === 'cleanup-tracks') {
		const session = doc.session;
		if (!session || session.documentTypeLoaded !== 'board') {
			return;
		}
		const { merged, removed } = session.cleanupTracks();
		if (merged === 0 && removed === 0) {
			setStatus('Cleanup Tracks and Vias: nothing to clean up.');
			return;
		}
		void (async () => {
			await sessionController.saveProject();
			updateEditSidebar();
			setStatus(`Cleanup Tracks and Vias: merged ${ merged } segment${ merged === 1 ? '' : 's' }, removed ${ removed } zero-length segment${ removed === 1 ? '' : 's' }.`);
		})();
		return;
	}
	if (command !== 'recreate-pcb') {
		return;
	}
	const session = doc.session;
	const board = doc.projectContext?.project.mainBoard;
	if (!session || !board || session.documentTypeLoaded !== 'board') {
		return;
	}
	const confirmed = window.confirm(
		'This deletes every footprint, track, via, zone, and net on this board and replaces it with a blank PCB. This cannot be undone. Continue?'
	);
	if (!confirmed) {
		return;
	}
	board.rootElement = KicadBoard.createBlank();
	void (async () => {
		await session.resyncBoardFromAst(board.rootElement!.write() + '\n');
		await sessionController.saveProject();
		updateEditSidebar();
		setStatus('PCB recreated from scratch.');
	})();
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
	openZoneDialogForOutline,
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
		// persist into project local settings if present
		const project = doc.projectContext?.project;
		if (project?.localSettings) {
			try {
				project.localSettings.setRatsnestVisible(Boolean(visible));
				void sessionController.saveProject();
				setStatus(`PCB ratsnest ${ visible ? 'shown' : 'hidden' } (saved).`);
			}
			catch (err) { setStatus('Could not persist ratsnest setting.'); }
		}
	},
	getBoardZoneDisplayMode: () => doc.session?.currentZoneDisplayMode ?? 'filled',
	setBoardZoneDisplayMode: mode => {
		doc.session?.setZoneDisplayMode(mode);
		setStatus(`PCB zones: ${ mode === 'filled' ? 'filled areas' : 'outlines only' }.`);
		const project = doc.projectContext?.project;
		if (project?.localSettings) {
			try {
				project.localSettings.setZoneDisplayMode(mode);
				void sessionController.saveProject();
				setStatus(`PCB zones: ${ mode === 'filled' ? 'filled areas' : 'outlines only' } (saved).`);
			}
			catch (err) { setStatus('Could not persist zone display mode.'); }
		}
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
		const project = doc.projectContext?.project;
		if (project?.localSettings) {
			try {
				project.localSettings.setPadDisplayMode(next);
				void sessionController.saveProject();
				setStatus(`Pads: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' } (saved).`);
			}
			catch (err) { setStatus('Could not persist pad display mode.'); }
		}
	},

	getBoardViaDisplayMode: () => doc.session?.currentViaDisplayMode ?? 'filled',
	cycleBoardViaDisplayMode: () => {
		const next = doc.session?.currentViaDisplayMode === 'outline' ? 'filled' : 'outline';
		doc.session?.setViaDisplayMode(next);
		setStatus(`Vias: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' }.`);
		const project = doc.projectContext?.project;
		if (project?.localSettings) {
			try {
				project.localSettings.setViaDisplayMode(next);
				void sessionController.saveProject();
				setStatus(`Vias: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' } (saved).`);
			}
			catch (err) { setStatus('Could not persist via display mode.'); }
		}
	},

	getBoardTrackDisplayMode: () => doc.session?.currentTrackDisplayMode ?? 'filled',
	cycleBoardTrackDisplayMode: () => {
		const next = doc.session?.currentTrackDisplayMode === 'outline' ? 'filled' : 'outline';
		doc.session?.setTrackDisplayMode(next);
		setStatus(`Tracks: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' }.`);
		const project = doc.projectContext?.project;
		if (project?.localSettings) {
			try {
				project.localSettings.setTrackDisplayMode(next);
				void sessionController.saveProject();
				setStatus(`Tracks: ${ next === 'outline' ? 'sketch (outline only)' : 'filled' } (saved).`);
			}
			catch (err) { setStatus('Could not persist track display mode.'); }
		}
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
	getBoardRoutingSizes: netName => {
		const rules = buildNetClassRules(doc.projectContext?.project.projectFile?.raw);
		const netClass = resolveNetClass(netName ?? '', rules);
		let trackWidth = Number(netClass.track_width) || 0.25;
		let viaSize = Number(netClass.via_diameter) || 0.6;
		let viaDrill = Number(netClass.via_drill) || 0.3;

		// Manual overrides from the new auxiliary toolbar's track-width/
		// via-size dropdowns take priority over the net class — index 0
		// means "use netclass" (real KiCad's own convention), matching
		// ActiveDocument.trackWidthIndex/viaSizeIndex's own doc comment.
		// board.design_settings.track_widths/via_dimensions are the same
		// raw JSON paths ProjectSettingsDraft.trackWidths/viaDimensions
		// read/write from Project Setup — read them directly here rather
		// than instantiating a whole ProjectSettingsDraft for one lookup,
		// mirroring buildNetClassRules's own direct-raw-read pattern.
		const raw = doc.projectContext?.project.projectFile?.raw;
		const designSettings = raw && typeof raw === 'object'
			? (raw as { board?: { design_settings?: Record<string, unknown> } }).board?.design_settings
			: undefined;
		if (doc.trackWidthIndex > 0) {
			const list = designSettings?.track_widths;
			const value = Array.isArray(list) ? Number(list[doc.trackWidthIndex - 1]) : NaN;
			if (Number.isFinite(value) && value > 0) {
				trackWidth = value;
			}
		}
		if (doc.viaSizeIndex > 0) {
			const list = designSettings?.via_dimensions;
			const entry = Array.isArray(list)
				? list[doc.viaSizeIndex - 1] as { diameter?: unknown; drill?: unknown } | undefined
				: undefined;
			const diameter = Number(entry?.diameter);
			const drill = Number(entry?.drill);
			if (Number.isFinite(diameter) && diameter > 0) {
				viaSize = diameter;
			}
			if (Number.isFinite(drill) && drill > 0) {
				viaDrill = drill;
			}
		}
		return { trackWidth, viaSize, viaDrill };
	},
	getBoardNetClassRules: (): NetClassRules => buildNetClassRules(doc.projectContext?.project.projectFile?.raw),
	getBoardRouteCornerMode: () => doc.routeCornerMode,
	setBoardRouteCornerMode: mode => { doc.routeCornerMode = mode; },
	getBoardRouterSettings: () => doc.routerSettings,
	setBoardRouterSettings: settings => { doc.routerSettings = settings; },
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
	chooseFootprintDirectory: () => footprintLibraryIndexer.chooseDirectory(),
	indexFootprintFallbackDirectory: files => footprintLibraryIndexer.indexFallbackDirectory(files),
	refreshSymbolLibraryButton: () => symbolLibraryIndexer.refreshButton(),
	refreshFootprintLibraryButton: () => footprintLibraryIndexer.refreshButton(),
	onProjectOpened: projectId => { void navigateWithGuards(
		{ screen: 'editor', projectId, view: 'schematic', sheet: null }, { replace: true }); }
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

function routeLeavesSchematicEditor(next: Route): boolean {
	const current = router.route;
	return current.screen === 'editor'
		&& current.view === 'schematic'
		&& next.screen === 'editor'
		&& next.view === 'board'
		&& doc.hasUnsavedSchematicChanges;
}

async function confirmLeaveSchematicEditor(): Promise<boolean> {
	const saveBeforeLeave = window.confirm(
		'Schematic has unsaved changes. Press OK to save before leaving this view.\nPress Cancel for discard/stay options.'
	);
	if (saveBeforeLeave) {
		await sessionController.saveProject();
		return !doc.hasUnsavedSchematicChanges;
	}
	return window.confirm('Discard unsaved schematic changes and continue to the next view?');
}

function routeLeavesBoardEditor(next: Route): boolean {
	const current = router.route;
	if (current.screen !== 'editor' || current.view !== 'board') {
		return false;
	}
	if (next.screen === 'editor' && next.view === 'board') {
		return false;
	}
	return doc.hasUnsavedBoardChanges;
}

async function confirmLeaveBoardEditor(): Promise<boolean> {
	const saveBeforeLeave = window.confirm(
		'PCB has unsaved changes. Press OK to save before leaving this view.\nPress Cancel for discard/stay options.'
	);
	if (saveBeforeLeave) {
		await sessionController.saveProject();
		return !doc.hasUnsavedBoardChanges;
	}
	return window.confirm('Discard unsaved PCB changes and continue to the next view?');
}

function routeLeavesSymbolEditor(next: Route): boolean {
	const current = router.route;
	return current.screen === 'symbol'
		&& next.screen !== 'symbol'
		&& symbolEditorScreen.isDirty;
}

async function confirmLeaveSymbolEditor(): Promise<boolean> {
	const saveBeforeLeave = window.confirm(
		'Symbol has unsaved changes. Press OK to save before leaving this editor.\nPress Cancel to discard and stay here.'
	);
	if (saveBeforeLeave) {
		const saved = await symbolEditorScreen.save();
		return saved;
	}
	return window.confirm('Discard unsaved symbol changes and continue?');
}

async function navigateWithGuards(route: Route, options?: { replace?: boolean }): Promise<void> {
	if (activeEditorView === 'project-settings' && !(route.screen === 'editor' && route.view === 'project-settings')
		&& !projectSetup.requestLeave()) {
		return;
	}
	if (routeLeavesSchematicEditor(route) && !await confirmLeaveSchematicEditor()) {
		return;
	}
	if (routeLeavesBoardEditor(route) && !await confirmLeaveBoardEditor()) {
		return;
	}
	if (routeLeavesSymbolEditor(route) && !await confirmLeaveSymbolEditor()) {
		return;
	}
	router.navigate(route, options);
}

// Editor screen otherwise has no way back to Project overview / Home short
// of the browser's own back button (not discoverable, and a dead end for
// e.g. a zip-opened project reached via a fresh tab, which can't silently
// reopen itself the way a folder project can via requestPermission()).
dom.brandHomeButton.addEventListener('click', () => {
	void navigateWithGuards(doc.projectContext
		? { screen: 'project', projectId: doc.projectContext.key }
		: { screen: 'home' });
});

// Schematic/PCB view-switcher tabs — client-side navigation within the
// already-open project (no reload, unlike Project overview's "open in new
// tab"), replacing what used to require going back to Project overview.
dom.viewTabSchematicBtn.addEventListener('click', () => {
	if (!doc.projectContext || activeEditorView === 'schematic') {
		return;
	}
	void navigateWithGuards({ screen: 'editor', projectId: doc.projectContext.key, view: 'schematic', sheet: null });
});
dom.viewTabBoardBtn.addEventListener('click', () => {
	if (!doc.projectContext || activeEditorView === 'board') {
		return;
	}
	void navigateWithGuards({ screen: 'editor', projectId: doc.projectContext.key, view: 'board', sheet: null });
});
dom.viewTabProjectSettingsBtn.addEventListener('click', () => {
	if (!doc.projectContext || activeEditorView === 'project-settings') return;
	void navigateWithGuards({ screen: 'editor', projectId: doc.projectContext.key, view: 'project-settings', sheet: null });
});

let homeScreen: HomeScreen;

homeScreen = new HomeScreen(dom.screenHomeEl, registry, {
	openFolder: () => {
		void sessionController.openProjectFolder().then(key => {
			if (key) {
				void navigateWithGuards({ screen: 'editor', projectId: key, view: 'schematic', sheet: null });
			}
		});
	},
	newProject: () => {
		void sessionController.newProject().then(key => {
			if (key) {
				void navigateWithGuards({ screen: 'editor', projectId: key, view: 'schematic', sheet: null });
			}
		});
	},
	openZip: file => {
		void sessionController.openProjectZip(file).then(key => {
			if (key) {
				void navigateWithGuards({ screen: 'editor', projectId: key, view: 'schematic', sheet: null });
			}
		});
	},
	openProject: projectId => { void navigateWithGuards({ screen: 'project', projectId }); },
	openScratchEditor: () => { void navigateWithGuards({ screen: 'editor', projectId: null, view: 'schematic', sheet: null }); },
	reindexSymbols: async () => {
		const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<any> }).showDirectoryPicker;
		try {
			if (!picker) {
				homeScreen.hideImportProgress();
				dom.symbolDirectoryInput.value = '';
				dom.symbolDirectoryInput.click();
				return;
			}
			homeScreen.showImportProgress('Symbols', 0, 0, 'Choosing directory…');
			const directory = await picker({ mode: 'read' });
			const summary = await symbolLibraryCache.indexDirectory(directory, progress => {
				homeScreen.showImportProgress('Symbols', progress.processedFiles, progress.totalFiles ?? 0, progress.fileName);
			});
			homeScreen.hideImportProgress();
			setStatus(`Indexed ${ summary.symbolCount } symbols from ${ summary.fileCount } files.`);
		}
		catch (error) {
			homeScreen.hideImportProgress();
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				setStatus(error instanceof Error ? error.message : String(error));
			}
		}
	},
	reindexFootprints: async () => {
		const picker = (window as Window & { showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<any> }).showDirectoryPicker;
		try {
			if (!picker) {
				homeScreen.hideImportProgress();
				dom.footprintDirectoryInput.value = '';
				dom.footprintDirectoryInput.click();
				return;
			}
			homeScreen.showImportProgress('Footprints', 0, 0, 'Choosing directory…');
			const directory = await picker({ mode: 'read' });
			const summary = await footprintLibraryCache.indexDirectory(directory, progress => {
				homeScreen.showImportProgress('Footprints', progress.processedFiles, progress.totalFiles ?? 0, progress.fileName);
			});
			homeScreen.hideImportProgress();
			setStatus(`Indexed ${ summary.footprintCount } footprints from ${ summary.fileCount } files.`);
		}
		catch (error) {
			homeScreen.hideImportProgress();
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				setStatus(error instanceof Error ? error.message : String(error));
			}
		}
	},
	clearSymbolLibrary: async () => {
		if (!window.confirm('Clear the cached symbol library from this browser?')) {
			return;
		}
		await symbolLibraryCache.clearAll();
		void homeScreen.refresh();
	},
	clearFootprintLibrary: async () => {
		if (!window.confirm('Clear the cached footprint library from this browser?')) {
			return;
		}
		await footprintLibraryCache.clearAll();
		void homeScreen.refresh();
	},
	getSymbolLibrarySummary: () => symbolLibraryCache.getSummary(),
	getFootprintLibrarySummary: () => footprintLibraryCache.getSummary(),
});

const projectOverviewScreen = new ProjectOverviewScreen(dom.screenProjectEl, registry, {
	openView: (projectId, view) => { void navigateWithGuards({ screen: 'editor', projectId, view, sheet: null }); },
	openViewNewTab: (projectId, view) => {
		const params = new URLSearchParams({ project: projectId, view });
		window.open(`${ window.location.pathname }?${ params.toString() }`, '_blank');
	},
	openSymbolEditor: projectId => { void navigateWithGuards({ screen: 'symbol', projectId, fileId: null }); },
	back: () => { void navigateWithGuards({ screen: 'home' }); }
});

const symbolEditorScreen = new SymbolEditorScreen(dom.screenSymbolEl, symbolLibraryCache, {
	saveFile: async (fileId, text) => {
		await symbolLibraryCache.updateFileText(fileId, text);
	},
	onBack: () => {
		const current = router.route;
		if (current.screen === 'symbol' && current.projectId) {
			void navigateWithGuards({ screen: 'project', projectId: current.projectId });
		}
		else {
			void navigateWithGuards({ screen: 'home' });
		}
	}
});

function showScreen(name: Route['screen']): void {
	dom.screenHomeEl.classList.toggle('hidden', name !== 'home');
	dom.screenProjectEl.classList.toggle('hidden', name !== 'project');
	dom.screenSymbolEl.classList.toggle('hidden', name !== 'symbol');
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
	if (route.screen === 'symbol') {
		showScreen('symbol');
		await symbolEditorScreen.open(route.fileId);
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
				projectSetup.activate(doc.projectContext, route.category ?? null);
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
