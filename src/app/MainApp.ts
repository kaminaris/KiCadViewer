import {
	KicadRenderSession,
	type KicadGlobalLabelShape,
	type KicadDirectiveLabelShape
}                                                                           from '@kicad-render/KicadRenderSession';
import { Vec2 }                                                             from '@kicad-render/math/Vec2';
import {
	wrapFullSchematic,
	type CircuitDesignRecipe,
	type CircuitPlacement,
	type LockedNetlist
}                                                                           from '@kicad-layout/index';
import {
	SymbolLibraryCache
}                                                                           from '../io/SymbolLibraryCache';
import { StatusBar }                                                        from './StatusBar';
import { Settings }                                                         from './Settings';
import { AppState, type AppMode }                                           from './AppState';
import { SessionController, type SessionControllerState }                   from './SessionController';
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
import { ToolStateController }                                              from '../editor/ToolStateController';
import { SymbolLibraryIndexer }                                             from '../io/SymbolLibraryIndexer';
import { wireMainAppInteractions }                                          from './wireMainAppInteractions';

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
const dom = createMainDomRefs();
const propertyPanel = new PropertyPanel();
const propertyRenderers = new PropertyRenderers(propertyPanel, {
	getSession: () => session,
	refreshSchematicText: activeSession => appState.refreshSchematicText(activeSession),
	refreshUndoStack: updateUndoStackPane
});
const propertiesDialog = new PropertiesDialog();
const propertyDialogRenderers = new PropertyDialogRenderers(propertiesDialog, {
	getSession: () => session,
	mutateElement: id => makeElementMutator(id),
	mutateSymbol: id => makeSymbolMutator(id),
	mutateLibrary: id => fn => {
		const activeSession = session;
		if (!activeSession?.mutateLibSymbolForInstance(id, fn)) {
			return;
		}
		appState.refreshSchematicText(activeSession);
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

let mode: AppMode = 'view';
let highlightNetEnabled = false;
/** Circuit-mode dragging (auto-rewire on drop). Always on in circuit mode —
 *  distinct from edit mode's manual, non-rewiring drag. */
let circuitDragMode = false;
let session: KicadRenderSession | null = null;
let recipe: CircuitDesignRecipe | null = null;
setHighlightNetEnabled(false);
let icSymbolText = '';
let placements: CircuitPlacement[] = [];
let placedFragment = '';
const appState = new AppState();
const runtime = new EditorRuntimeState();
/** Locked pin↔net map from the opened schematic (recipe-free rewire). */
let lockedNetlist: LockedNetlist | null = null;
let selectedRef: string | null = null;
let rerouting = false;

// ---- Edit mode: hand-drawn wires/junctions/no-connects/graphics ----
let editTool: EditTool = 'select';
/** Wire/bus tools: last committed chain point (world, snapped), or null if no chain in progress. */
let lineChainStart: Vec2 | null = null;
/** Line/rect/circle/text-box tools: first-click anchor, or null before it. */
let shapeAnchor: Vec2 | null = null;
/** Arc tool: 0, 1 ([start]), or 2 ([start, end]) points clicked so far. */
let arcPoints: Vec2[] = [];
/** Bezier tool: 0..4 points (start, control 1, control 2, end). */
let bezierPoints: Vec2[] = [];
let ruleAreaPoints: Vec2[] = [];
const pendingShapeTracker = new PendingShapeTracker();
const editGestureTracker = new EditGestureTracker();

function syncPendingShapeTracker(): void {
	if (lineChainStart) {
		pendingShapeTracker.set({ kind: 'chain', start: lineChainStart });
	}
	else if (shapeAnchor) {
		pendingShapeTracker.set({ kind: 'anchor', start: shapeAnchor });
	}
	else if (arcPoints.length) {
		pendingShapeTracker.set({ kind: 'arc', points: arcPoints });
	}
	else if (bezierPoints.length) {
		pendingShapeTracker.set({ kind: 'bezier', points: bezierPoints });
	}
	else if (ruleAreaPoints.length) {
		pendingShapeTracker.set({ kind: 'rule-area', points: ruleAreaPoints });
	}
	else {
		pendingShapeTracker.clear();
	}
}

let editSelectedId: string | null = null;
let editSelectedKind: string | null = null;
let currentLabelShape: KicadGlobalLabelShape = 'input';
let currentDirectiveLabelShape: KicadDirectiveLabelShape = 'round';
let currentPowerKind: PowerKind = settings.current.powerKind;

function setStatus(msg: string): void { statusBar.setStatus(msg); }

let propertiesController: PropertiesController;
let toolStateController: ToolStateController;

function updateEditSidebar(): void { propertiesController.updateEditSidebar(); }

function updateUndoStackPane(): void { propertiesController.updateUndoStackPane(); }

function makeSymbolMutator(id: string): (fn: (symbol: any) => void) => void {
	return fn => {
		const activeSession = session;
		if (!activeSession?.mutateSymbolByPaintId(id, fn)) {
			return;
		}
		appState.refreshSchematicText(activeSession);
		updateUndoStackPane();
	};
}

function makeElementMutator(id: string): (fn: (element: any) => void) => void {
	return fn => {
		const activeSession = session;
		if (!activeSession?.mutateElementByPaintId(id, fn)) {
			return;
		}
		appState.refreshSchematicText(activeSession);
		updateUndoStackPane();
	};
}

function updateLockedNets(): void {
	if (!lockedNetlist) {
		dom.lockedNetsEl.textContent = 'No schematic netlist locked.';
		return;
	}
	const rows = Object.entries(lockedNetlist.pinNetsByRef)
		.flatMap(([ref, pins]) => Object.entries(pins).map(([pin, net]) => `${ ref }.${ pin }  →  ${ net }`))
		.sort((a, b) => a.localeCompare(b));
	dom.lockedNetsEl.textContent = `${ lockedNetlist.summary.netCount } nets · ${ rows.length } locked pins\n\n${ rows.join(
		'\n') }`;
}

function snap(n: number): number { return settings.snap(n); }

function setGridSpacing(mm: number): void {
	settings.setGridSpacingMm(mm);
	session?.setGridSpacing(mm);
}

function setHighlightNetEnabled(enabled: boolean): void {
	highlightNetEnabled = enabled;
	dom.highlightNetButton.classList.toggle('active', enabled);
	dom.highlightNetButton.setAttribute('aria-pressed', String(enabled));
	dom.highlightNetButton.title = enabled ? 'Highlight Net (click a pin/label/wire to select the net)' :
		'Highlight Net';
	dom.canvas.style.cursor = enabled ? 'crosshair' : '';
	if (!enabled) {
		session?.clearNetHighlight();
	}
}

dom.gridSelectEl.addEventListener('change', () => {
	const mm = Number(dom.gridSelectEl.value);
	if (Number.isFinite(mm) && mm > 0) {
		setGridSpacing(mm);
	}
});

function updateStatusBar(screenPos?: Vec2): void {
	statusBar.updateCoordZoom(session, screenPos);
}

const sessionControllerState: SessionControllerState = {
	get mode() { return mode; },
	set mode(value) { mode = value; },
	get circuitDragMode() { return circuitDragMode; },
	set circuitDragMode(value) { circuitDragMode = value; },
	get session() { return session; },
	set session(value) { session = value; },
	get lockedNetlist() { return lockedNetlist; },
	set lockedNetlist(value) { lockedNetlist = value; },
	get placements() { return placements; },
	set placements(value) { placements = value; },
	get placedFragment() { return placedFragment; },
	set placedFragment(value) { placedFragment = value; },
	get selectedRef() { return selectedRef; },
	set selectedRef(value) { selectedRef = value; },
	get editSelectedId() { return editSelectedId; },
	set editSelectedId(value) { editSelectedId = value; },
	get rerouting() { return rerouting; },
	set rerouting(value) { rerouting = value; },
	get recipe() { return recipe; },
	set recipe(value) { recipe = value; },
	get icSymbolText() { return icSymbolText; },
	set icSymbolText(value) { icSymbolText = value; }
};

const symbolChooser = new SymbolChooser(symbolLibraryCache, {
	getSession: () => session,
	refreshSchematicText: activeSession => appState.refreshSchematicText(activeSession),
	setSelectedReference: reference => { selectedRef = reference; },
	setStatus,
	setEditTool: tool => toolStateController.setEditTool(tool)
});
const contextMenu = new ContextMenu(dom.stage);

const textInputFlow = new TextInputFlow(appState, {
	getSession: () => session,
	getTool: () => editTool,
	getHitElement: id => (session as any)?.schScene?.hitTestItems?.find((item: any) => item.id === id)?.element,
	getLabelShape: () => currentLabelShape,
	setLabelShape: shape => { currentLabelShape = shape; },
	getDirectiveLabelShape: () => currentDirectiveLabelShape,
	setDirectiveLabelShape: shape => { currentDirectiveLabelShape = shape; },
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
	getMode: () => mode,
	getSession: () => session,
	getLastPointerWorld: () => runtime.lastPointerWorld,
	snap,
	setEditTool: tool => toolStateController.setEditTool(tool),
	setStatus,
	refreshSchematicText: activeSession => { appState.refreshSchematicText(activeSession); },
	setImageSelection: id => {
		editSelectedId = id;
		editSelectedKind = 'image';
	},
	refreshSidebar: updateEditSidebar,
	openKiCadFile: file => sessionController.openKiCadFile(file)
});
propertiesController = new PropertiesController({
	getSession: () => session,
	getMode: () => mode,
	editPropertiesEl: dom.editPropertiesEl,
	propertiesModalEl: dom.propertiesModalEl,
	propertyPanel,
	propertyRenderers,
	propertyDialogRenderers,
	propertiesDialog,
	multiEditNames: PROPERTY_MULTI_EDIT_NAMES
});
toolStateController = new ToolStateController({
	getSession: () => session,
	getEditTool: () => editTool,
	setEditToolValue: tool => { editTool = tool; },
	clearSymbolPlacement: () => symbolChooser.clearPlacement(),
	clearLineChainStart: () => { lineChainStart = null; },
	clearShapeAnchor: () => { shapeAnchor = null; },
	clearArcPoints: () => { arcPoints = []; },
	clearBezierPoints: () => { bezierPoints = []; },
	clearRuleAreaPoints: () => { ruleAreaPoints = []; },
	clearPendingShapeTracker: () => pendingShapeTracker.clear(),
	endGesture: () => { editGestureTracker.end(); },
	clearPendingTableState: () => {
		dom.tableModal.classList.add('hidden');
	},
	hidePropertiesModal: () => { propertiesController.closePropertiesModal(); },
	resetLabelShapes: () => {
		currentLabelShape = 'input';
		currentDirectiveLabelShape = 'round';
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
	clearEditPreview: () => { session?.setEditPreview(null); }
});

let sessionController: SessionController;
sessionController = new SessionController(sessionControllerState, appState, settings, statusBar, dom, {
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
	updateLockedNets
});

function updateCircuitHint(): void {
	if (mode === 'edit') {
		const shapeHint = (editTool === 'global-label' || editTool === 'hier-label')
			? ` · shape: ${ currentLabelShape } (Tab to cycle)`
			: editTool === 'directive-label'
				? ` · shape: ${ currentDirectiveLabelShape } (Tab to cycle)`
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
	const n = placements.length;
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
	editSelectedId = sole;
	editSelectedKind = item?.kind ?? null;
	selectedRef = (item?.kind === 'symbol' && item.refDesignator) ? item.refDesignator : null;
}

function clearSelectionBookkeeping(): void {
	selectedRef = null;
	editSelectedId = null;
	editSelectedKind = null;
}

const toolbar = new Toolbar(settings, {
	getActiveTool: () => editTool,
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
		if (editTool === 'power') {
			toolStateController.resetEditToolState();
			updateCircuitHint();
		}
	}
});
const editToolButtons = toolbar.buttons;

dom.recipeInput.addEventListener('change', async (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}
	recipe = JSON.parse(await file.text()) as CircuitDesignRecipe;
	setStatus(`Recipe loaded (${ file.name }).`);
	updateCircuitHint();
});

dom.symbolInput.addEventListener('change', async (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}
	icSymbolText = await file.text();
	setStatus(`Symbol loaded (${ file.name }).`);
	updateCircuitHint();
});

wireMainAppInteractions({
	dom,
	settings,
	appState,
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
	getSession: () => session,
	getMode: () => mode,
	getCircuitDragMode: () => circuitDragMode,
	getEditTool: () => editTool,
	getHighlightNetEnabled: () => highlightNetEnabled,
	setHighlightNetEnabled,
	getCurrentPowerKind: () => currentPowerKind,
	getGridSpacingMm: () => settings.current.gridSpacingMm,
	ensurePlacement: ref => sessionController.ensurePlacement(ref),
	getPlacements: () => placements,
	getRuleAreaPoints: () => ruleAreaPoints,
	setRuleAreaPoints: points => { ruleAreaPoints = points; },
	getLineChainStart: () => lineChainStart,
	setLineChainStart: value => { lineChainStart = value; },
	getShapeAnchor: () => shapeAnchor,
	setShapeAnchor: value => { shapeAnchor = value; },
	getArcPoints: () => arcPoints,
	setArcPoints: points => { arcPoints = points; },
	getBezierPoints: () => bezierPoints,
	setBezierPoints: points => { bezierPoints = points; },
	getEditSelectedId: () => editSelectedId,
	setEditSelectedId: id => { editSelectedId = id; },
	getEditSelectedKind: () => editSelectedKind,
	setEditSelectedKind: kind => { editSelectedKind = kind; },
	setSelectedRef: ref => { selectedRef = ref; },
	clearSelectionBookkeeping,
	syncPendingShapeTracker,
	syncSingleSelectionBookkeeping,
	updateStatusBar,
	updateEditSidebar,
	updateUndoStackPane,
	setStatus,
	dbg: (...args) => statusBar.dbg(...args),
	snap,
	loadDemo: () => sessionController.loadDemo(),
	openKiCadFile: file => sessionController.openKiCadFile(file),
	runPlace: () => sessionController.runPlace(),
	commitReroute: connectivity => sessionController.commitReroute(connectivity),
	downloadSchematic: () => sessionController.downloadSchematic(
		recipe?.ic.mpn || 'circuit', placedFragment.trim() ? wrapFullSchematic(placedFragment) : ''),
	refreshSchematicText: activeSession => { appState.refreshSchematicText(activeSession); },
	chooseSymbolDirectory: () => symbolLibraryIndexer.chooseDirectory(),
	indexFallbackDirectory: files => symbolLibraryIndexer.indexFallbackDirectory(files),
	refreshSymbolLibraryButton: () => symbolLibraryIndexer.refreshButton()
});
