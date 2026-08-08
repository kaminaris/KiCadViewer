import {
	KicadRenderSession,
	type EditPreviewState,
	type KicadGlobalLabelShape,
	type KicadDirectiveLabelShape,
	type ResizeHandle,
	type SelectionResizeBox,
	type CurveAnchor,
	type SelectionCurveAnchors,
	type AlignAxis
}                                                                           from '@kicad-render/KicadRenderSession';
import { Vec2 }                                                             from '@kicad-render/math/Vec2';
import {
	applyLockedPinNets,
	isEditablePowerPlacement,
	lockNetlistFromSchematic,
	rewireSchematic,
	wrapFullSchematic,
	type CircuitDesignRecipe,
	type CircuitPlacement,
	type LockedNetlist
}                                                                           from '@kicad-layout/index';
import { reroute }                                                          from '@kicad-layout/Reroute';
import {
	SymbolLibraryCache,
	type SymbolDirectoryHandle,
	type SymbolLibraryProgress,
	type SymbolLibrarySummary
}                                                                           from './SymbolLibraryCache';
import { POWER_KIND_ICONS, LABEL_TOOL_ICONS, SHAPE_TOOL_ICONS }             from './icons';
import { StatusBar }                                                        from './StatusBar';
import { Settings }                                                         from './Settings';
import { AppState, type AppMode }                                           from './AppState';
import { SessionController, type SessionControllerState }                   from './SessionController';
import { SymbolChooser }                                                    from './SymbolChooser';
import { Toolbar, type EditTool as ToolbarEditTool }                        from './Toolbar';
import { TextInputFlow }                                                    from './TextInputFlow';
import { ContextMenu }                                                      from './ContextMenu';
import { PropertyPanel }                                                    from './PropertyPanel';
import { PropertyRenderers, MULTI_EDIT_NAMES as PROPERTY_MULTI_EDIT_NAMES } from './PropertyRenderers';
import { PropertyDialogRenderers }                                          from './PropertyDialogRenderers';
import { PendingShapeTracker }                                              from './PendingShape';
import { EditGestureTracker }                                               from './EditGesture';
import { PropertiesDialog }                                                 from './PropertiesDialog';

type EditTool = ToolbarEditTool;

interface EmbeddedImagePayload {
	data: string;
	mimeType: 'image/png' | 'image/jpeg' | 'image/gif';
}

/** Edit-mode tool-switch hotkeys. R/T are already rotate/tidy, so Rect and
 *  Text have no letter here — toolbar-button only for those two. Local
 *  label/power tools are also button-only (no unclaimed letter left that
 *  isn't a worse mnemonic than just clicking). */
const EDIT_TOOL_HOTKEYS: Record<string, EditTool> = {
	s: 'select',
	w: 'wire',
	j: 'junction',
	x: 'no-connect',
	l: 'line',
	c: 'circle',
	a: 'arc',
	b: 'bezier',
	g: 'global-label',
	h: 'hier-label'
};

/** Shape cycle for the global/hier label tools (Tab while placing). */
const LABEL_SHAPES: KicadGlobalLabelShape[] = ['input', 'output', 'bidirectional', 'tri_state', 'passive'];
/** Same idea for the directive-label tool — a glyph style, not an
 *  electrical direction, so a completely different vocabulary/list. */
const DIRECTIVE_LABEL_SHAPES: KicadDirectiveLabelShape[] = ['round', 'dot', 'diamond', 'rectangle'];

/** Power tool variant, right-click-cycled on the toolbar button (GND covers
 *  the overwhelming majority of real usage, so it's the one-click default
 *  rather than a 3-button spread or a full symbol-chooser dialog). */
type PowerKind = 'gnd' | 'flag' | 'rail';
const POWER_KIND_CYCLE: PowerKind[] = ['gnd', 'flag', 'rail'];
const POWER_KIND_LABELS: Record<PowerKind, string> = { gnd: 'GND', flag: 'PWR_FLAG', rail: 'Rail' };

/** A "cyclable" toolbar button collapses several related EditTools (KiCad
 *  itself groups these the same way — see eeschema/toolbars_sch_editor.cpp's
 *  TOOLBAR_GROUP_CONFIG( "Labels" ) etc.) behind one icon: left-click places
 *  whichever member is current, right-click advances to the next. Unlike the
 *  power tool (one EditTool, a behavioral sub-kind), each member here is a
 *  fully distinct EditTool already wired everywhere else in this file — this
 *  is a toolbar-presentation compression only, not a state-machine change. */
interface ToolGroupMember {
	tool: EditTool;
	/** Plain command name — used for the Place submenu row, same style as
	 *  every other (non-grouped) button's title, e.g. "Wire", "Junction". */
	menuLabel: string;
	/** Toolbar-button hover text — longer, explains the cycle gesture. */
	title: string;
	icon: string;
}

interface ToolGroupDef {
	buttonId: string;
	members: ToolGroupMember[];
}

const LABEL_GROUP: ToolGroupDef = {
	buttonId: 'btn-label-tool',
	members: [
		{
			tool: 'label', menuLabel: 'Label: Local',
			title: 'Label: Local — right-click to cycle Local/Directive/Global/Hierarchical',
			icon: LABEL_TOOL_ICONS['label']
		},
		{
			tool: 'directive-label', menuLabel: 'Label: Directive',
			title: 'Label: Directive (netclass flag) — right-click to cycle · Tab cycles shape while placing',
			icon: LABEL_TOOL_ICONS['directive-label']
		},
		{
			tool: 'global-label', menuLabel: 'Label: Global (G)',
			title: 'Label: Global (G) — right-click to cycle · Tab cycles shape while placing',
			icon: LABEL_TOOL_ICONS['global-label']
		},
		{
			tool: 'hier-label', menuLabel: 'Label: Hierarchical (H)',
			title: 'Label: Hierarchical (H) — right-click to cycle · Tab cycles shape while placing',
			icon: LABEL_TOOL_ICONS['hier-label']
		}
	]
};
const SHAPE_GROUP: ToolGroupDef = {
	buttonId: 'btn-shape-tool',
	members: [
		{ tool: 'line', menuLabel: 'Line (L)', title: 'Line (L)', icon: SHAPE_TOOL_ICONS.line },
		{ tool: 'rect', menuLabel: 'Rectangle', title: 'Rectangle', icon: SHAPE_TOOL_ICONS.rect },
		{ tool: 'circle', menuLabel: 'Circle (C)', title: 'Circle (C)', icon: SHAPE_TOOL_ICONS.circle },
		{ tool: 'arc', menuLabel: 'Arc (A)', title: 'Arc (A)', icon: SHAPE_TOOL_ICONS.arc },
		{ tool: 'bezier', menuLabel: 'Bezier Curve (B)', title: 'Bezier Curve (B)', icon: SHAPE_TOOL_ICONS.bezier }
	]
};
const TOOL_GROUPS: ToolGroupDef[] = [LABEL_GROUP, SHAPE_GROUP];

/** Tools that place via the floating text input (vs. one-click commit).
 *  'power' is a one-click tool UNLESS currentPowerKind === 'rail' — handled
 *  as an extra condition alongside this set, not a static membership. */
const TEXT_INPUT_TOOLS: ReadonlySet<EditTool> = new Set(
	['text', 'label', 'directive-label', 'global-label', 'hier-label']);

const TEXT_INPUT_PLACEHOLDERS: Partial<Record<EditTool, string>> = {
	text: 'Text…',
	label: 'Net name…',
	'directive-label': 'Netclass name…',
	'global-label': 'Global label…',
	'hier-label': 'Hierarchical label…',
	power: 'Voltage (e.g. +3.3V)…'
};

/** Screen-pixel distance before a rectangle-select mousedown counts as a
 *  drag rather than a click — the box is unsnapped, so the existing
 *  world-snapped dragMoved idiom doesn't apply here. */
const RECT_SELECT_MOVE_THRESHOLD_PX = 4;

const statusBar = new StatusBar();
const settings = new Settings();
settings.load();
const lockedNetsEl = document.getElementById('locked-nets')!;
const stage = document.getElementById('stage')!;
const canvas = document.getElementById('canvas2d') as HTMLCanvasElement;
const modeViewBtn = document.getElementById('mode-view')!;
const modeCircuitBtn = document.getElementById('mode-circuit')!;
const modeEditBtn = document.getElementById('mode-edit')!;
const viewActions = document.getElementById('view-actions')!;
const circuitActions = document.getElementById('circuit-actions')!;
const editActions = document.getElementById('edit-actions')!;
const indexSymbolsButton = document.getElementById('btn-index-symbols') as HTMLButtonElement;
const symbolDirectoryInput = document.getElementById('symbol-directory-input') as HTMLInputElement;
const editLeftPane = document.getElementById('edit-left-pane')!;
const editPropertiesEl = document.getElementById('edit-properties')!;
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
	show: showPropertiesModal
});
const editHierarchyEl = document.getElementById('edit-hierarchy')!;
const toolPanel = document.getElementById('tool-panel')!;
const mainEl = document.querySelector('main')!;
const editTextInput = document.getElementById('edit-text-input') as HTMLInputElement;
const editTextBoxInput = document.getElementById('edit-text-box-input') as HTMLTextAreaElement;
const tableModal = document.getElementById('table-modal') as HTMLDivElement;
const tableRowsInput = document.getElementById('table-rows') as HTMLInputElement;
const tableColumnsInput = document.getElementById('table-columns') as HTMLInputElement;
const tableDataInput = document.getElementById('table-data') as HTMLTextAreaElement;
const imageInput = document.getElementById('image-input') as HTMLInputElement;
const symbolLibraryCache = new SymbolLibraryCache();
const propertiesModalEl = document.getElementById('properties-modal') as HTMLDivElement;
const contextMenuEl = document.getElementById('context-menu') as HTMLDivElement;
const gridSelectEl = document.getElementById('grid-select') as HTMLSelectElement;

// The canvas editor listens for pointer gestures higher in the document.
// Inspector controls must be an interaction island: otherwise a checkbox
// click is interpreted as a canvas pointer-up, which rebuilds the inspector
// and immediately steals focus/rolls the control back.
for (const eventName of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick']) {
	editPropertiesEl.addEventListener(eventName, event => event.stopPropagation());
	// The properties modal uses the same interaction-island treatment as the
	// sidebar, so a
	// checkbox/select/color click inside it must not reach window's own
	// mousemove/mouseup drag-tracking listeners.
	propertiesModalEl.addEventListener(eventName, event => event.stopPropagation());
}

let mode: AppMode = 'view';
/** Circuit-mode dragging (auto-rewire on drop). Always on in circuit mode —
 *  distinct from edit mode's manual, non-rewiring drag. */
let circuitDragMode = false;
let session: KicadRenderSession | null = null;
let recipe: CircuitDesignRecipe | null = null;
let icSymbolText = '';
let placements: CircuitPlacement[] = [];
let placedFragment = '';
const appState = new AppState();
/** Locked pin↔net map from the opened schematic (recipe-free rewire). */
let lockedNetlist: LockedNetlist | null = null;
let selectedRef: string | null = null;
let rerouting = false;

let draggingPan = false;
let dragStart = new Vec2(0, 0);
/** Symbol ref being dragged — circuit mode (auto-rewire on drop) OR edit
 *  mode's select tool (manual move, no rewire); mode alone disambiguates. */
/** Edit mode only — the specific unit-instance's paint id, alongside
 *  the symbol drag. Several placed instances can share one Reference
 *  (multi-unit parts, e.g. five "U1"s), so the instance id disambiguates them;
 *  always null in circuit mode, where a placements-array ref is already
 *  unique on its own. */
/** Global / hierarchical label being dragged (local labels are regenerated). */
/** Hierarchical sheet box being dragged — absolute-position like a symbol
 *  (shares dragOffset/dragStartPose with it), not a relative-
 *  delta translateElementById path: moving a sheet must ALSO shift its
 *  properties and pins by the same amount (see moveSheetById's doc
 *  comment), which a single-point relative translate can't express. */
/** Sheet pin being dragged — also absolute-position (shares dragOffset/
 *  dragStartPose), and MUST be intercepted before the generic
 *  label-drag path: a sheet pin has kind:'label' like any other label, but
 *  translateElementById's generic getOrigin/setOrigin fallback would move
 *  it freely with no edge-constraint, unlike moveSheetPinById's real-KiCad-
 *  ported ConstrainOnEdge behavior (see its doc comment). */
let dragOffset = new Vec2(0, 0);
let dragMoved = false;
let dragUndoCaptured = false;
let dragStartPose: { x: number; y: number; rotation: number } | null = null;

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

/** Select tool: non-symbol element (wire/junction/no-connect/graphic/text) being dragged. */
/** An outer selection handle is being dragged. The center handle uses the
 * ordinary editDrag path, since its contract is exactly "move this item". */
/** Select tool: rectangle multi-select drag in progress from empty space —
 *  origin is fixed at mousedown, deliberately unsnapped (raw world coords,
 *  matching real KiCad's own selection box, unlike every placement tool's
 *  grid-snapped preview). */
/** Select tool: dragging the WHOLE current multi-selection together, started
 *  by a plain (no-modifier) mousedown on an item that's already part of a
 *  2+ item selection. lastSnapped is the cursor's own snapped world
 *  position, re-anchored every mousemove — the per-step delta from it is
 *  what actually moves every selected item (see translateSelection), same
 *  incremental element-drag technique. */
/** Select tool: paint-item id/kind of whatever's currently selected (for Delete-key policy). */
let editSelectedId: string | null = null;
let editSelectedKind: string | null = null;
/** Text tool: world position of the pending (not-yet-committed) text. */
let pendingTextAnchor: Vec2 | null = null;
/** Bounds captured by Draw Text Box's two-click gesture while its multiline
 * editor is open. */
let pendingTextBoxBounds: { x: number; y: number; width: number; height: number } | null = null;
let pendingTableAnchor: Vec2 | null = null;
let pendingTableId: string | null = null;
/** Image selected through the toolbar and waiting for its placement click. */
let pendingImagePayload: EmbeddedImagePayload | null = null;
/** Most recent canvas world position, used for clipboard-image placement. */
let lastPointerWorld: Vec2 | null = null;
/** In-memory copy/cut clipboard — cloned .write() text per copied element
 *  plus each one's own original world position, so a multi-item paste can
 *  preserve relative layout instead of stacking everything at one point.
 *  Deliberately NOT the real OS clipboard (avoids MIME-type/permission
 *  complexity for a same-tab feature) — the `paste` listener further down
 *  already owns real clipboard reads, for image-drop only, and is untouched
 *  by this. */
let clipboard: { sourceText: string; x: number; y: number }[] = [];
/** Set when the floating text input is editing an EXISTING label's text
 *  (via the context menu's "Edit Text…") rather than placing a new one —
 *  commitTextInput() checks this first, since editTool could be anything
 *  at menu-invocation time and would be the wrong dispatch key here. */
let editingLabelId: string | null = null;
/** Global/hier label tools: shape cycled by Tab while the text input is open. */
let currentLabelShape: KicadGlobalLabelShape = 'input';
/** Directive-label tool: same idea, separate vocabulary (dot/round/diamond/rectangle). */
let currentDirectiveLabelShape: KicadDirectiveLabelShape = 'round';
/** Power tool: variant right-click-cycled on the toolbar button. */
let currentPowerKind: PowerKind = settings.current.powerKind;

/** Transitional delegates to `statusBar` — main.ts is being split into
 *  per-concern classes across several steps; each new class takes `statusBar`
 *  as a constructor collaborator and calls it directly, so these thin
 *  wrappers shrink and disappear as that migration proceeds rather than
 *  being a permanent extra layer. */
function dbg(...args: unknown[]): void { statusBar.dbg(...args); }

function setStatus(msg: string): void { statusBar.setStatus(msg); }

function symbolSummaryLabel(summary: SymbolLibrarySummary): string {
	const errors = summary.errorCount ? `, ${ summary.errorCount } failed` : '';
	return `Indexed ${ summary.symbolCount } symbols from ${ summary.fileCount } files${ errors }.`;
}

function reportSymbolIndexProgress(progress: SymbolLibraryProgress): void {
	const total = progress.totalFiles ? `/${ progress.totalFiles }` : '';
	const suffix = progress.error ? ` — ${ progress.error }` : ` — ${ progress.symbolCount } symbols`;
	setStatus(`Indexing symbols ${ progress.processedFiles }${ total }: ${ progress.fileName }${ suffix }`);
}

async function refreshSymbolLibraryButton(): Promise<void> {
	try {
		const summary = await symbolLibraryCache.getSummary();
		if (summary) {
			indexSymbolsButton.title = `${ symbolSummaryLabel(summary) } Click to rescan.`;
		}
	}
	catch {
		// IndexedDB may be disabled by a protected browsing policy; indexing will
		// report the actionable error when the user actually tries it.
	}
}

async function indexFallbackDirectory(files: FileList): Promise<void> {
	indexSymbolsButton.disabled = true;
	try {
		const firstPath = (files[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
		const rootName = firstPath?.split('/')[0] || 'Selected symbols directory';
		const summary = await symbolLibraryCache.indexFiles(files, rootName, reportSymbolIndexProgress);
		setStatus(symbolSummaryLabel(summary));
		indexSymbolsButton.title = `${ symbolSummaryLabel(summary) } Click to rescan.`;
	}
	catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
	}
	finally {
		indexSymbolsButton.disabled = false;
		symbolDirectoryInput.value = '';
	}
}

async function chooseSymbolDirectory(): Promise<void> {
	const picker = (window as Window & {
		showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<SymbolDirectoryHandle>;
	}).showDirectoryPicker;
	if (!picker) {
		symbolDirectoryInput.value = '';
		symbolDirectoryInput.click();
		return;
	}
	indexSymbolsButton.disabled = true;
	try {
		const directory = await picker({ mode: 'read' });
		const summary = await symbolLibraryCache.indexDirectory(directory, reportSymbolIndexProgress);
		setStatus(symbolSummaryLabel(summary));
		indexSymbolsButton.title = `${ symbolSummaryLabel(summary) } Click to rescan.`;
	}
	catch (error) {
		// AbortError is the normal result of closing the directory chooser.
		if (!(error instanceof DOMException && error.name === 'AbortError')) {
			setStatus(error instanceof Error ? error.message : String(error));
		}
	}
	finally {
		indexSymbolsButton.disabled = false;
	}
}

function renderSelectedProperties(): void {
	if (!session || mode !== 'edit') {
		return;
	}
	// session.selection degrades to null for BOTH "0 selected" and "2+
	// selected" (see its own doc comment) — handle the multi-item case
	// first so it doesn't fall into the "No objects selected" branch below,
	// which would be actively misleading for a real multi-selection.
	if (session.selectionIds.size > 1) {
		const items = (session.activeScene?.hitTestItems ?? []).filter(item => session!.selectionIds.has(item.id));
		const names = new Set(items.map(item => (item as any).element?.name));
		const [onlyName] = names;
		if (items.length > 0 && names.size === 1 && onlyName && PROPERTY_MULTI_EDIT_NAMES.has(onlyName)) {
			propertyRenderers.renderMulti(
				onlyName, items.map(item => (item as any).element), items.map(item => item.id));
		}
		else {
			editPropertiesEl.textContent = `${ session.selectionIds.size } objects selected`;
		}
		return;
	}
	const selected = session.selection;
	if (!selected) {
		editPropertiesEl.textContent = 'No objects selected';
	}
	else {
		const hit = session.activeScene?.hitTestItems.find(item => item.id === selected);
		const element = (hit as any)?.element;
		if (!hit || !element) {
			editPropertiesEl.textContent = 'No objects selected';
		}
		else {
			const labelKind = (hit as any).labelKind as string | undefined;
			switch (hit.kind) {
				case 'symbol':
					propertyRenderers.renderSymbol(element, hit.kind, hit.id);
					break;
				case 'symbol-graphic':
					propertyRenderers.renderShape(element, hit.kind, hit.id);
					break;
				case 'wire':
				case 'bus':
					propertyRenderers.renderWireBus(element, hit.kind, hit.id);
					break;
				case 'junction':
					propertyRenderers.renderJunction(element, hit.id);
					break;
				case 'text':
					// kind:'text' also covers table cells (KicadElementTableCell),
					// which have a wholly different property surface (row/col
					// span, per-cell margins, …) real KiCad exposes through its
					// own separate DIALOG_TABLECELL_PROPERTIES — out of scope
					// here, so they fall through to the generic display below
					// rather than getting a mismatched text/font panel.
					if (element.name === 'text' || element.name === 'text_box') {
						propertyRenderers.renderText(element, hit.id);
					}
					else {
						editPropertiesEl.textContent = `${ hit.kind }\nID: ${ hit.id }`;
					}
					break;
				case 'label':
					propertyRenderers.renderLabel(element, labelKind, hit.id);
					break;
				default:
					editPropertiesEl.textContent = `${ hit.kind }\nID: ${ hit.id }`;
			}
		}
	}
}

function updateEditSidebar(): void {
	if (!session || mode !== 'edit') {
		return;
	}
	propertyPanel.refreshSidebar(session, renderSelectedProperties);
}

function updateUndoStackPane(): void {
	if (!session) {
		return;
	}
	propertyPanel.refreshUndoStack(session);
}

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

for (const splitter of Array.from(document.querySelectorAll<HTMLElement>('.pane-splitter'))) {
	splitter.addEventListener('pointerdown', (event) => {
		event.preventDefault();
		const before = splitter.previousElementSibling as HTMLElement | null;
		const parent = splitter.parentElement;
		if (!before || !parent) {
			return;
		}
		const startY = event.clientY;
		const startHeight = before.getBoundingClientRect().height;
		const move = (moveEvent: PointerEvent) => {
			const next = Math.max(60, Math.min(parent.clientHeight - 120, startHeight + moveEvent.clientY - startY));
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

function setScore(text: string): void { statusBar.setScore(text); }

function updateLockedNets(): void {
	if (!lockedNetlist) {
		lockedNetsEl.textContent = 'No schematic netlist locked.';
		return;
	}
	const rows = Object.entries(lockedNetlist.pinNetsByRef)
		.flatMap(([ref, pins]) => Object.entries(pins).map(([pin, net]) => `${ ref }.${ pin }  →  ${ net }`))
		.sort((a, b) => a.localeCompare(b));
	lockedNetsEl.textContent = `${ lockedNetlist.summary.netCount } nets · ${ rows.length } locked pins\n\n${ rows.join(
		'\n') }`;
}

function snap(n: number): number { return settings.snap(n); }

/** Return the schematic anchor used for grid placement, not a painted bbox
 * corner. Bboxes include text/graphic extents that are intentionally allowed
 * to sit off-grid; origins and geometry endpoints are the points KiCad snaps
 * when an item is placed or pasted. */
function pasteAnchor(element: any): { x: number; y: number } | null {
	if (typeof element?.getOrigin === 'function') {
		const origin = element.getOrigin();
		if (Number.isFinite(origin?.x) && Number.isFinite(origin?.y)) {
			return { x: origin.x, y: origin.y };
		}
	}
	if (typeof element?.getPoints === 'function') {
		const point = element.getPoints()?.[0];
		if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
			return { x: point.x, y: point.y };
		}
	}
	if (typeof element?.getStartMidEnd === 'function') {
		const point = element.getStartMidEnd()?.start;
		if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
			return { x: point.x, y: point.y };
		}
	}
	if (typeof element?.getStartEnd === 'function') {
		const point = element.getStartEnd()?.start;
		if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
			return { x: point.x, y: point.y };
		}
	}
	if (typeof element?.getCenter === 'function') {
		const point = element.getCenter();
		if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
			return { x: point.x, y: point.y };
		}
	}
	if (typeof element?.getPolyline === 'function') {
		return pasteAnchor(element.getPolyline());
	}
	return null;
}

/** Group drags are delta-based for mixed selections. Quantize ordinary label
 * attach points once at drop so a pasted off-grid label cannot retain a
 * fractional origin merely because it moved as part of a group. */
function snapSelectionLabels(s: KicadRenderSession): void {
	for (const id of s.selectionIds) {
		const item = s.activeScene?.hitTestItems.find(candidate => candidate.id === id);
		if (item?.kind !== 'label' || item.labelKind === 'sheet-pin') {
			continue;
		}
		const origin = (item.element as any)?.getOrigin?.();
		if (!origin) {
			continue;
		}
		const x = snap(origin.x);
		const y = snap(origin.y);
		if (x !== origin.x || y !== origin.y) {
			s.moveLabelById(id, x, y, origin.rotation);
		}
	}
}

/** Rectangle-select AND single-item-click modifier semantics — matches real
 *  KiCad's own drag-select mapping exactly (SELECTION_TOOL::setModifiersState,
 *  common/tool/selection_tool.cpp), confirmed against the user's local KiCad
 *  checkout and against the user directly: Shift alone or Ctrl alone both
 *  ADD (not "ctrl subtracts", which is a common but incorrect assumption);
 *  only Ctrl+Shift together subtracts. Applied uniformly to single-item
 *  clicks too for consistency, even though real KiCad's own plain-click Ctrl
 *  behavior differs from its drag behavior (a toggle, not a plain add) —
 *  deliberately not porting that click-specific nuance here. */
function rectSelectionModeFromModifiers(e: MouseEvent): 'replace' | 'add' | 'subtract' {
	if (e.shiftKey && e.ctrlKey) {
		return 'subtract';
	}
	if (e.shiftKey || e.ctrlKey) {
		return 'add';
	}
	return 'replace';
}

/** #grid-select IS the grid display now (its selected option shows the
 *  current value) — no separate text label to keep in sync, unlike the
 *  coord/zoom fields below which have no interactive counterpart. */
function setGridSpacing(mm: number): void {
	settings.setGridSpacingMm(mm);
	session?.setGridSpacing(mm);
}

gridSelectEl.addEventListener('change', () => {
	const mm = Number(gridSelectEl.value);
	if (Number.isFinite(mm) && mm > 0) {
		setGridSpacing(mm);
	}
});

function updateStatusBar(screenPos?: Vec2): void {
	statusBar.updateCoordZoom(session, screenPos);
}

const RESIZE_HANDLE_ORDER: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'w', 'center', 'e', 'sw', 's', 'se'];

function resizeHandleAtScreen(s: KicadRenderSession, screenPos: Vec2): {
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

function resizedBoundsFromHandle(
	box: SelectionResizeBox, handle: Exclude<ResizeHandle, 'center'>, cursor: Vec2
): SelectionResizeBox {
	let left = box.x;
	let right = box.x + box.width;
	let top = box.y;
	let bottom = box.y + box.height;
	const grid = settings.current.gridSpacingMm;
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

function curveAnchorAtScreen(s: KicadRenderSession, screenPos: Vec2): {
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

function canRecipeAutoroute(): boolean {
	return sessionController.canRecipeAutoroute();
}

function canLockedAutoroute(): boolean {
	return sessionController.canLockedAutoroute();
}

function canAutoroute(): boolean {
	return sessionController.canAutoroute();
}

function lockNetlistFromText(text: string, force = false): void {
	sessionController.lockNetlistFromText(text, force);
}

function poseToPlacement(pose: {
	ref: string;
	libId: string;
	x: number;
	y: number;
	rotation: number;
}): CircuitPlacement {
	const isGnd = pose.libId === 'power:GND' || pose.ref.startsWith('#PWR');
	const pinNets = lockedNetlist?.pinNetsByRef[pose.ref] ?? {};
	return {
		ref: pose.ref,
		role: isGnd ? 'GND' : 'PART',
		libId: pose.libId || 'Unknown',
		x: pose.x,
		y: pose.y,
		rotation: pose.rotation,
		value: pose.ref,
		nets: Object.values(pinNets),
		pinNets: { ...pinNets }
	};
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
	setEditTool
});
const contextMenu = new ContextMenu(stage);

const textInputFlow = new TextInputFlow(appState, {
	getSession: () => session,
	getTool: () => editTool,
	getHitElement,
	getLabelShape: () => currentLabelShape,
	setLabelShape: shape => { currentLabelShape = shape; },
	getDirectiveLabelShape: () => currentDirectiveLabelShape,
	setDirectiveLabelShape: shape => { currentDirectiveLabelShape = shape; },
	setStatus,
	updateHint: updateCircuitHint
});

const sessionController = new SessionController(sessionControllerState, appState, settings, statusBar, {
	closeSymbolChooser: () => symbolChooser.clearPlacement(),
	resetEditToolState,
	refreshHint: updateCircuitHint,
	refreshSidebar: updateEditSidebar,
	clearLastPointer: () => { lastPointerWorld = null; },
	lockNetlistFromText,
	syncPlacementsFromSession,
	canLockedAutoroute,
	relockNetlistFromLiveText,
	restoreSelection,
	ensurePlacement,
	canAutoroute,
	commitReroute: () => commitReroute('autoroute'),
	updateLockedNets
});

function ensureSession(): KicadRenderSession {
	return sessionController.ensureSession();
}

function resizeCanvas(): void {
	sessionController.resizeCanvas();
}

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
	if (canLockedAutoroute()) {
		statusBar.setHint(
			`Edit on · ${ n } parts · drag / R rotate / T tidy labels · netlist locked · full rewire on drop`);
		return;
	}
	if (canRecipeAutoroute()) {
		statusBar.setHint(`Edit on · ${ n } parts · drag / R · recipe rewire on drop`);
		return;
	}
	statusBar.setHint(`Edit on · ${ n } parts · drag / R (open a wired schematic to lock nets)`);
}

/**
 * Build edit placements from the parsed AST in the render session — not from
 * brittle regex on raw text. Recipe is NOT required for drag/rotate.
 */
function syncPlacementsFromSession(): number {
	return sessionController.syncPlacementsFromSession();
}

/** Ensure we have a placement row for this ref (create from AST if needed). */
function ensurePlacement(ref: string): CircuitPlacement | null {
	return sessionController.ensurePlacement(ref);
}

/**
 * Re-lock the netlist from the LIVE session text (not the possibly-stale
 * appState-cached copy) — picks up any hand-drawn wires edit mode left
 * behind instead of silently discarding them on the next rewire. Called on
 * every entry to circuit mode, and again after undo/redo while already
 * there (those can restore text without a mode-switch event).
 */
function relockNetlistFromLiveText(): void {
	sessionController.relockNetlistFromLiveText();
}

function setMode(next: AppMode): void {
	sessionController.setMode(next);
}

async function loadTextIntoSession(text: string, kind: 'schematic' | 'board', filename: string): Promise<void> {
	return sessionController.loadText(text, kind, filename);
}

async function openKiCadFile(file: File): Promise<void> {
	return sessionController.openKiCadFile(file);
}

async function loadDemo(): Promise<void> {
	return sessionController.loadDemo();
}

function runPlace(): void {
	sessionController.runPlace();
}

/** Status/score after a locked rewire — invalid (red) nets are the to-do list. */
function reportRewire(
	invalidNets: string[],
	breakdown: string,
	warnings: string[],
	connectivity: 'autoroute' | 'clear-wires'
): void {
	if (connectivity === 'clear-wires') {
		setStatus('Wires cleared — every pin flagged with a net label.');
	}
	else if (invalidNets.length) {
		setStatus(
			`Rewired — ${ invalidNets.length } net(s) need attention (red): `
			+ `${ invalidNets.join(', ') }. Move parts apart to clear.`
		);
	}
	else {
		setStatus('Rewired — all nets clean.');
	}
	setScore(breakdown + (warnings.length ? `\n${ warnings.join('\n') }` : ''));
}

async function commitReroute(connectivity: 'autoroute' | 'clear-wires' = 'autoroute'): Promise<void> {
	return sessionController.commitReroute(connectivity);
}

function restoreSelection(): void {
	sessionController.restoreSelection();
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

/** Copy/Cut/Duplicate scope filter: sheets and sheet pins are excluded —
 *  a sheet carries hierarchical-file/page-numbering implications beyond
 *  this app's single-file edit scope, and a cloned sheet pin without its
 *  specific parent sheet is meaningless. Every other kind (including
 *  symbols) is fine to copy/duplicate freely. */
function copyableIds(s: KicadRenderSession, ids: string[]): string[] {
	const hitItems = s.activeScene?.hitTestItems ?? [];
	return ids.filter(id => {
		const it = hitItems.find(h => h.id === id);
		return !!it && it.kind !== 'sheet' && !(it.kind === 'label' && (it as any).labelKind === 'sheet-pin');
	});
}

/** Cut's scope is copyableIds further minus symbols — matches the Delete
 *  handler's existing "symbols aren't deletable in edit mode" rule. Cut
 *  never copies-then-leaves a symbol behind: since it can't delete one, it
 *  skips copying it too, so a later Paste can't silently duplicate what
 *  looked like a "moved" item. */
function cuttableIds(s: KicadRenderSession, ids: string[]): string[] {
	const hitItems = s.activeScene?.hitTestItems ?? [];
	return copyableIds(s, ids).filter(id => hitItems.find(h => h.id === id)?.kind !== 'symbol');
}

function beginSymbolDrag(ref: string, screenPos: Vec2): void {
	if (!circuitDragMode || !session) {
		return;
	}
	const placement = ensurePlacement(ref);
	if (!placement) {
		dbg('beginSymbolDrag failed', {
			ref,
			placementCount: placements.length,
			astPose: session.getSymbolPose(ref),
			listSample: session.listSymbolPoses().slice(0, 20)
		});
		setStatus(`Selected ${ ref }, but AST has no pose for it — check console.`);
		return;
	}
	dbg('beginSymbolDrag', placement);
	session.pushUndoSnapshot('Symbol drag');
	const world = session.screenToWorld(screenPos);
	dragMoved = false;
	dragStartPose = { x: placement.x, y: placement.y, rotation: placement.rotation };
	dragOffset = new Vec2(world.x - placement.x, world.y - placement.y);
	editGestureTracker.begin({ kind: 'symbol', ref, instanceId: null, offset: dragOffset, startPose: dragStartPose });
}

/** Edit mode's select-tool symbol drag start — sources the pose directly
 *  from the live AST, unlike circuit mode's placements-array-backed variant
 *  (edit mode never touches placements/pinNets — it's not net-aware).
 *  `instanceId` (the hit paint id) disambiguates which unit of a multi-unit
 *  part to move — the tracker carries the instance id. */
function beginEditSymbolDrag(ref: string, instanceId: string, screenPos: Vec2): void {
	if (!session) {
		return;
	}
	const pose = session.getSymbolPose(ref, instanceId);
	if (!pose) {
		return;
	}
	const world = session.screenToWorld(screenPos);
	dragMoved = false;
	dragStartPose = { x: pose.x, y: pose.y, rotation: pose.rotation };
	dragOffset = new Vec2(world.x - pose.x, world.y - pose.y);
	editGestureTracker.begin({ kind: 'symbol', ref, instanceId, offset: dragOffset, startPose: dragStartPose });
}

/** Select-tool sheet drag start — mirrors beginEditSymbolDrag exactly, just
 *  sourced from the sheet's own element (no ref-designator lookup; sheets
 *  aren't reference-numbered) and with rotation always 0 (see
 *  KicadElementSheet's doc comment — sheets have no rotation concept). */
function beginSheetDrag(paintId: string, screenPos: Vec2): void {
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
	dragMoved = false;
	dragStartPose = { x: pos.x, y: pos.y, rotation: 0 };
	dragOffset = new Vec2(world.x - pos.x, world.y - pos.y);
	editGestureTracker.begin({ kind: 'sheet', id: paintId, offset: dragOffset, startPose: dragStartPose });
}

/** Select-tool sheet-PIN drag start — same shape as beginSheetDrag, sourced
 *  from the pin's own current position (moveSheetPinById re-derives which
 *  edge it belongs to fresh on every mousemove, so only the starting grab
 *  offset needs capturing here). */
function beginSheetPinDrag(paintId: string, screenPos: Vec2): void {
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
	dragMoved = false;
	dragStartPose = { x: pos.x, y: pos.y, rotation: pos.rotation ?? 0 };
	dragOffset = new Vec2(world.x - pos.x, world.y - pos.y);
	editGestureTracker.begin({ kind: 'sheet-pin', id: paintId, offset: dragOffset, startPose: dragStartPose });
}

async function rotateSelected(): Promise<void> {
	return sessionController.rotateSelected();
}

function downloadSchematic(): void {
	sessionController.downloadSchematic(
		recipe?.ic.mpn || 'circuit', placedFragment.trim() ? wrapFullSchematic(placedFragment) : '');
}

/** Convert a browser Blob into the binary-string payload used by KiCad's
 * `(data ...)` element. Only formats understood by the existing schematic
 * renderer are accepted; this keeps unsupported clipboard formats from
 * creating an AST object that renders as a blank rectangle. */
async function readEmbeddedImage(blob: Blob): Promise<EmbeddedImagePayload> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const isPng = bytes.length >= 8
		&& bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
		&& bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
	const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	const isGif = bytes.length >= 6
		&& bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
		&& (bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61);
	const mimeType: EmbeddedImagePayload['mimeType'] | null = isPng
		? 'image/png'
		: isJpeg
			? 'image/jpeg'
			: isGif ? 'image/gif' : null;
	if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/gif') {
		throw new Error('Only PNG, JPEG, and GIF images are supported.');
	}
	let data = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		data += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
	}
	return { data, mimeType };
}

function insertImageAt(payload: EmbeddedImagePayload, anchor: Vec2): boolean {
	if (mode !== 'edit' || !session || session.documentTypeLoaded !== 'schematic') {
		setStatus('Open a schematic in Edit mode before inserting an image.');
		return false;
	}
	const id = session.addGraphicImage(anchor.x, anchor.y, payload.data, payload.mimeType);
	if (!id) {
		setStatus('Could not insert image.');
		return false;
	}
	appState.refreshSchematicText(session);
	session.select(id);
	editSelectedId = id;
	editSelectedKind = 'image';
	setStatus('Added image.');
	updateEditSidebar();
	return true;
}

function startImageInsertion(): void {
	setEditTool('image');
	pendingImagePayload = null;
	imageInput.value = '';
	imageInput.click();
}

function screenPosFromEvent(e: MouseEvent): Vec2 {
	const rect = canvas.getBoundingClientRect();
	const x = (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
	const y = (e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
	return new Vec2(x, y);
}

/** Resolve the live AST element behind a paint-item id for text-input and
 * label-edit flows. The renderer intentionally keeps this scene detail
 * private, so the editor provides the narrow adapter those flows need. */
function getHitElement(id: string): any {
	return (session as any)?.schScene?.hitTestItems?.find((item: any) => item.id === id)?.element;
}

const toolbar = new Toolbar(settings, {
	getActiveTool: () => editTool,
	setActiveTool: setEditTool,
	onToolClick: tool => {
		if (tool === 'image') {
			startImageInsertion();
		}
		else if (tool === 'place-symbol') {
			setEditTool('place-symbol');
			setStatus('Click on canvas to choose where to place a symbol.');
		}
		else {
			setEditTool(tool);
		}
	},
	onPowerKindChanged: () => {
		currentPowerKind = toolbar.powerKind;
		if (editTool === 'power') {
			resetEditToolState();
			updateCircuitHint();
		}
	}
});
const editToolButtons = toolbar.buttons;

modeViewBtn.addEventListener('click', () => setMode('view'));
modeCircuitBtn.addEventListener('click', () => setMode('circuit'));
modeEditBtn.addEventListener('click', () => setMode('edit'));

const powerToolButton = document.getElementById('btn-power-tool') as HTMLButtonElement;

function updatePowerToolButton(): void {
	const svg = powerToolButton.querySelector('svg.tool-icon');
	if (svg) {
		svg.innerHTML = POWER_KIND_ICONS[currentPowerKind];
	}
	powerToolButton.title = `Power symbol: ${ POWER_KIND_LABELS[currentPowerKind] } — right-click to cycle GND/PWR_FLAG/rail`;
}

function cyclePowerKind(): void {
	const idx = POWER_KIND_CYCLE.indexOf(currentPowerKind);
	currentPowerKind = POWER_KIND_CYCLE[(idx + 1) % POWER_KIND_CYCLE.length]!;
	settings.setPowerKind(currentPowerKind);
	updatePowerToolButton();
	if (editTool === 'power') {
		// Live-refresh whatever preview/input state the previous variant left
		// behind — e.g. switching away from 'rail' while text input is open.
		resetEditToolState();
		updateCircuitHint();
	}
}

updatePowerToolButton();

/** Paints a group's current member onto its collapsed button — icon, title,
 *  and (critically) `data-tool`, since every other consumer (the generic
 *  click handler above, setEditTool's .active loop, buildPlaceSubmenu) keys
 *  off `dataset.tool` as the button's live state, not a parallel map. */
function updateGroupButton(button: HTMLButtonElement, member: ToolGroupMember): void {
	button.dataset.tool = member.tool;
	const svg = button.querySelector('svg.tool-icon');
	if (svg) {
		svg.innerHTML = member.icon;
	}
	button.title = member.title;
}

function findToolGroup(tool: EditTool): ToolGroupDef | undefined {
	return TOOL_GROUPS.find(g => g.members.some(m => m.tool === tool));
}

/** Keeps a group's collapsed button showing whatever tool is actually active
 *  — needed because a member tool can become active via paths that never
 *  touch the button itself (hotkeys, the Place submenu's expanded entries). */
function syncGroupButtonForTool(tool: EditTool): void {
	const group = findToolGroup(tool);
	if (!group) {
		return;
	}
	const button = document.getElementById(group.buttonId) as HTMLButtonElement | null;
	const member = group.members.find(m => m.tool === tool);
	if (button && member) {
		updateGroupButton(button, member);
	}
}

function cycleGroup(group: ToolGroupDef): void {
	const button = document.getElementById(group.buttonId) as HTMLButtonElement | null;
	if (!button) {
		return;
	}
	const idx = group.members.findIndex(m => m.tool === button.dataset.tool);
	const next = group.members[(idx + 1) % group.members.length]!;
	if (group.members.some(m => m.tool === editTool)) {
		// Group is the active tool right now — actually switch to the next
		// member (setEditTool syncs the button itself via syncGroupButtonForTool).
		setEditTool(next.tool);
	}
	else {
		// Not active — just advance what a future left-click will place.
		updateGroupButton(button, next);
	}
}

for (const group of TOOL_GROUPS) {
	const button = document.getElementById(group.buttonId) as HTMLButtonElement | null;
	if (!button) {
		continue;
	}
	updateGroupButton(button, group.members[0]!);
}

document.getElementById('file-input')!.addEventListener('change', (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (file) {
		void openKiCadFile(file);
	}
});

document.getElementById('circuit-file-input')!.addEventListener('change', (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (file) {
		if (mode !== 'circuit') {
			setMode('circuit');
		}
		void openKiCadFile(file);
	}
});

document.getElementById('btn-demo')!.addEventListener('click', () => {
	void loadDemo().catch(err => setStatus(String(err)));
});

document.getElementById('recipe-input')!.addEventListener('change', async (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}
	recipe = JSON.parse(await file.text()) as CircuitDesignRecipe;
	setStatus(`Recipe loaded (${ file.name }).`);
	updateCircuitHint();
});

document.getElementById('symbol-input')!.addEventListener('change', async (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}
	icSymbolText = await file.text();
	setStatus(`Symbol loaded (${ file.name }).`);
	updateCircuitHint();
});

imageInput.addEventListener('change', async () => {
	const file = imageInput.files?.[0];
	if (!file) {
		return;
	}
	try {
		pendingImagePayload = await readEmbeddedImage(file);
		setEditTool('image');
		setStatus(`Image loaded (${ file.name }) — click the schematic to place it.`);
	}
	catch (err) {
		pendingImagePayload = null;
		setStatus(err instanceof Error ? err.message : String(err));
	}
});

indexSymbolsButton.addEventListener('click', () => {
	void chooseSymbolDirectory();
});

symbolDirectoryInput.addEventListener('change', () => {
	const files = symbolDirectoryInput.files;
	if (files?.length) {
		void indexFallbackDirectory(files);
	}
});

document.getElementById('btn-place')!.addEventListener('click', () => runPlace());
document.getElementById('btn-autowire')!.addEventListener('click', () => {
	session?.pushUndoSnapshot();
	void commitReroute('autoroute');
});
document.getElementById('btn-clear-wires')!.addEventListener('click', () => {
	session?.pushUndoSnapshot();
	void commitReroute('clear-wires');
});
document.getElementById('btn-export')!.addEventListener('click', () => downloadSchematic());
document.getElementById('btn-export-edit')!.addEventListener('click', () => downloadSchematic());
document.getElementById('btn-undo')!.addEventListener('click', () => void performUndo());
document.getElementById('btn-redo')!.addEventListener('click', () => void performRedo());

canvas.addEventListener('wheel', (e) => {
	e.preventDefault();
	ensureSession().zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
	updateStatusBar();
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
	// A click that's just dismissing an open modal/menu shouldn't ALSO act on
	// whatever's underneath it (place/select/pan) — swallow it here. This
	// gap was a real, live bug for the symbol chooser specifically: with
	// place-symbol now opening the chooser reactively (from a canvas click),
	// a SECOND canvas click landing while it's still open would otherwise
	// reach handleEditModeMouseDown's place-symbol branch and — since
	// The chooser fills its first result asynchronously, so a second canvas
	// click while the modal is visible must not place that symbol underneath it.
	if (contextMenu.isOpen || !propertiesModalEl.classList.contains('hidden') || symbolChooser.isOpen) {
		return;
	}
	const s = ensureSession();
	const screenPos = screenPosFromEvent(e);
	if (mode === 'edit') {
		if (handleEditModeMouseDown(e, s, screenPos)) {
			return;
		}
		draggingPan = true;
		dragStart = screenPos;
		return;
	}
	if (mode === 'circuit' && circuitDragMode) {
		const symHit = s.hitTestSymbolAtScreen(screenPos);
		dbg('mousedown hit', symHit);
		if (symHit?.refDesignator) {
			selectedRef = symHit.refDesignator;
			s.select(symHit.id);
			beginSymbolDrag(symHit.refDesignator, screenPos);
			e.preventDefault();
			return;
		}
		// Global / hierarchical labels are real terminals — draggable. Local
		// labels are regenerated each rewire, so they are not.
		const labelHit = s.hitTestLabelAtScreen(screenPos);
		if (labelHit?.id && labelHit.labelKind && labelHit.labelKind !== 'local') {
			selectedRef = null;
			s.select(labelHit.id);
			s.pushUndoSnapshot();
			const world = s.screenToWorld(screenPos);
			const el = (s as any).schScene?.hitTestItems?.find((it: any) => it.id === labelHit.id)?.element;
			const origin = el?.getOrigin?.() ?? { x: world.x, y: world.y, rotation: 0 };
			dragMoved = false;
			dragStartPose = { x: origin.x, y: origin.y, rotation: origin.rotation ?? 0 };
			dragOffset = new Vec2(world.x - origin.x, world.y - origin.y);
			editGestureTracker.begin({ kind: 'label', id: labelHit.id, offset: dragOffset, startPose: dragStartPose });
			e.preventDefault();
			return;
		}
		selectedRef = null;
		s.select(null);
	}
	draggingPan = true;
	dragStart = screenPos;
});

function onPointerMove(e: MouseEvent): void {
	const s = session;
	if (!s) {
		return;
	}
	const activeGesture = editGestureTracker.current;
	const pos = screenPosFromEvent(e);
	lastPointerWorld = s.screenToWorld(pos);
	updateStatusBar(pos);

	if (mode === 'edit' && editTool !== 'select') {
		const worldPos = s.screenToWorld(pos);
		updateEditPreview(s, new Vec2(snap(worldPos.x), snap(worldPos.y)));
		return;
	}
	if (mode === 'edit' && activeGesture.kind === 'curve') {
		const worldPos = s.screenToWorld(pos);
		if (s.moveCurveAnchorById(activeGesture.id, activeGesture.anchor, snap(worldPos.x), snap(worldPos.y))) {
			dragMoved = true;
		}
		return;
	}
	if (mode === 'edit' && activeGesture.kind === 'resize') {
		const worldPos = s.screenToWorld(pos);
		const bounds = resizedBoundsFromHandle(
			activeGesture.original, activeGesture.handle, new Vec2(snap(worldPos.x), snap(worldPos.y)));
		if (s.resizeElementBoundsById(
			activeGesture.id, bounds.x, bounds.y, bounds.width, bounds.height, activeGesture.handle)) {
			dragMoved = true;
		}
		return;
	}
	if (mode === 'edit' && activeGesture.kind === 'element') {
		const worldPos = s.screenToWorld(pos);
		const snapped = new Vec2(snap(worldPos.x), snap(worldPos.y));
		if (activeGesture.lastSnapped) {
			const dx = snapped.x - activeGesture.lastSnapped.x;
			const dy = snapped.y - activeGesture.lastSnapped.y;
			if (dx !== 0 || dy !== 0) {
				s.translateElementById(activeGesture.id, dx, dy);
				editGestureTracker.update({ kind: 'element', id: activeGesture.id, lastSnapped: snapped });
				dragMoved = true;
			}
		}
		return;
	}
	if (mode === 'edit' && activeGesture.kind === 'rect-select') {
		const worldPos = s.screenToWorld(pos);
		if (!dragMoved && Math.hypot(pos.x - activeGesture.originScreen.x, pos.y - activeGesture.originScreen.y)
			> RECT_SELECT_MOVE_THRESHOLD_PX) {
			dragMoved = true;
		}
		const boxMode: 'contained' | 'touching' = worldPos.x >= activeGesture.originWorld.x ? 'contained' : 'touching';
		s.setEditPreview({
			kind: 'selection-box', origin: activeGesture.originWorld, cursor: worldPos,
			mode: boxMode, selectMode: rectSelectionModeFromModifiers(e)
		});
		return;
	}
	if (mode === 'edit' && activeGesture.kind === 'group') {
		const worldPos = s.screenToWorld(pos);
		const snapped = new Vec2(snap(worldPos.x), snap(worldPos.y));
		const dx = snapped.x - activeGesture.lastSnapped.x;
		const dy = snapped.y - activeGesture.lastSnapped.y;
		if (dx !== 0 || dy !== 0) {
			if (!dragUndoCaptured) {
				s.pushUndoSnapshot('Group drag');
				dragUndoCaptured = true;
			}
			s.translateSelection([...s.selectionIds], dx, dy);
			editGestureTracker.update({ kind: 'group', lastSnapped: snapped });
			dragMoved = true;
		}
		return;
	}
	if (activeGesture.kind === 'label') {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - activeGesture.offset.x);
		const ny = snap(worldPos.y - activeGesture.offset.y);
		if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
			dragMoved = true;
		}
		s.moveLabelById(activeGesture.id, nx, ny, activeGesture.startPose.rotation);
		return;
	}
	if (activeGesture.kind === 'sheet') {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - activeGesture.offset.x);
		const ny = snap(worldPos.y - activeGesture.offset.y);
		if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
			dragMoved = true;
		}
		if (dragMoved && !dragUndoCaptured) {
			s.pushUndoSnapshot('Sheet drag');
			dragUndoCaptured = true;
		}
		s.moveSheetById(activeGesture.id, nx, ny);
		return;
	}
	if (activeGesture.kind === 'sheet-pin') {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - activeGesture.offset.x);
		const ny = snap(worldPos.y - activeGesture.offset.y);
		if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
			dragMoved = true;
		}
		if (dragMoved && !dragUndoCaptured) {
			s.pushUndoSnapshot('Sheet pin drag');
			dragUndoCaptured = true;
		}
		s.moveSheetPinById(activeGesture.id, nx, ny);
		return;
	}
	if (activeGesture.kind === 'symbol') {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - activeGesture.offset.x);
		const ny = snap(worldPos.y - activeGesture.offset.y);
		if (mode === 'edit') {
			// Manual move — no placements bookkeeping, no rewire on drop.
			if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
				dragMoved = true;
			}
			if (dragMoved && !dragUndoCaptured) {
				s.pushUndoSnapshot('Symbol drag');
				dragUndoCaptured = true;
			}
			s.moveSymbolByRef(
				activeGesture.ref, nx, ny, activeGesture.startPose.rotation, activeGesture.instanceId ?? undefined);
			return;
		}
		const placement = placements.find(p => p.ref === activeGesture.ref);
		if (!placement) {
			return;
		}
		placement.x = nx;
		placement.y = ny;
		if (isEditablePowerPlacement(placement)) {
			placement.rotation = 0;
		}
		if (nx !== activeGesture.startPose.x || ny !== activeGesture.startPose.y) {
			dragMoved = true;
		}
		s.moveSymbolByRef(placement.ref, placement.x, placement.y, placement.rotation);
		return;
	}
	if (!draggingPan) {
		return;
	}
	s.pan(pos.x - dragStart.x, pos.y - dragStart.y);
	dragStart = pos;
}

function onPointerUp(e: MouseEvent): void {
	const finishedGesture = editGestureTracker.end();
	const moved = dragMoved;
	const gestureKind = finishedGesture.kind;
	const isSymbolGesture = gestureKind === 'symbol';
	const isLabelGesture = gestureKind === 'label';
	const isElementGesture = gestureKind === 'element';
	const isResizeGesture = gestureKind === 'resize';
	const isCurveGesture = gestureKind === 'curve';
	const isSheetGesture = gestureKind === 'sheet';
	const isSheetPinGesture = gestureKind === 'sheet-pin';
	const rectGesture = finishedGesture.kind === 'rect-select' ?
		{ originWorld: finishedGesture.originWorld, originScreen: finishedGesture.originScreen } : null;
	const isRectGesture = !!rectGesture;
	const isGroupGesture = gestureKind === 'group';
	editGestureTracker.moved = moved;
	draggingPan = false;
	// Any symbol OR global/hier label move → full net-locked rewire (the single
	// edit path; the moved label/rail is preserved and wires re-route to it).
	if (mode === 'circuit' && circuitDragMode && (isSymbolGesture || isLabelGesture) && moved) {
		void commitReroute('autoroute');
	}
	else if (mode === 'edit' && (isSymbolGesture || isLabelGesture || isElementGesture || isResizeGesture
		|| isCurveGesture
		|| isSheetGesture || isSheetPinGesture || isGroupGesture) && moved && session) {
		// Manual move, no rewire — just persist the mutated AST text. Covers
		// group-drag too: translateSelection already applied every step's
		// delta live during the drag, same as every other kind here — this
		// branch only needs to persist the final text once.
		if (isGroupGesture) {
			snapSelectionLabels(session);
		}
		appState.refreshSchematicText(session);
	}
	else if (mode === 'edit' && isRectGesture && session) {
		const s = session;
		if (moved) {
			const worldPos = s.screenToWorld(screenPosFromEvent(e));
			const boxMode: 'contained' | 'touching' = worldPos.x >= rectGesture!.originWorld.x ? 'contained' :
				'touching';
			const hitIds = s.hitTestRect(rectGesture!.originWorld, worldPos, boxMode);
			// A box that touches just one member of a group still pulls in
			// every other member — grouped items behave as one unit for
			// rect-select the same way a plain click on one does below.
			s.selectMultiple(s.expandGroupSelection(hitIds), rectSelectionModeFromModifiers(e));
		}
		else if (!e.shiftKey && !e.ctrlKey) {
			s.select(null);
		}
		// else: modifier held, nothing dragged, nothing hit — no-op, matches
		// real KiCad's degenerate zero-size-box behavior (adds/subtracts
		// nothing rather than clobbering an accumulated selection).
		syncSingleSelectionBookkeeping(s);
		s.setEditPreview(null);
		dbg('rect-select commit', { moved, ids: [...s.selectionIds] });
	}
	dragMoved = false;
	dragUndoCaptured = false;
	dragStartPose = null;
	updateEditSidebar();
}

canvas.addEventListener('dblclick', (event) => {
	if (mode === 'edit' && editTool === 'rule-area' && ruleAreaPoints.length >= 3) {
		const s = ensureSession();
		s.addRuleArea(ruleAreaPoints.map(point => ({ x: point.x, y: point.y })));
		appState.refreshSchematicText(s);
		ruleAreaPoints = [];
		s.setEditPreview(null);
		event.preventDefault();
		return;
	}
	if (mode === 'edit' && editTool === 'select') {
		const hit = ensureSession().hitTestAtScreen(screenPosFromEvent(event));
		if (hit?.kind === 'table') {
			showTableEditModal(hit.id);
			event.preventDefault();
			return;
		}
		if (hit) {
			showPropertiesModal(hit.id);
			event.preventDefault();
			return;
		}
	}
	// Safety net: double-click ends an in-progress wire/bus chain. The mousedown
	// same-point guard in handleEditModeMouseDown already handles the common
	// case (both clicks of a dblclick land on the same snapped point), this
	// covers any environment where that doesn't hold.
	if (mode === 'edit' && (editTool === 'wire' || editTool === 'bus') && lineChainStart) {
		lineChainStart = null;
		session?.setEditPreview(null);
	}
});

window.addEventListener('mousemove', onPointerMove);
window.addEventListener('mouseup', onPointerUp);

/** Undo/redo work identically regardless of mode — one global history. */
async function performUndo(): Promise<void> {
	return sessionController.undo();
}

async function performRedo(): Promise<void> {
	return sessionController.redo();
}

window.addEventListener('keydown', (e) => {
	syncPendingShapeTracker();
	const t = e.target as HTMLElement | null;
	if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
		return;
	}

	if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		if (e.shiftKey) {
			void performRedo();
		}
		else {
			void performUndo();
		}
		return;
	}
	if ((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		void performRedo();
		return;
	}
	// Matches real KiCad's own zoomFitScreen hotkey exactly (common/tool/
	// actions.cpp) — works in every mode, same as undo/redo above, since
	// "see the whole thing" is a navigation action, not an edit-mode one.
	if (e.key === 'Home' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
		e.preventDefault();
		session?.fitSchematicContent();
		return;
	}

	if (mode === 'edit') {
		// Copy/Cut/Paste/Duplicate — gated on editTool === 'select' the same
		// way Delete/Backspace below already is, so none of these interfere
		// with an in-progress multi-click gesture (wire chain, shape anchor,
		// …) in some other tool. Bare c/x/d are already tool hotkeys
		// (circle/no-connect/…) but those are ALL gated on no-modifiers, so
		// there's no collision with the Ctrl-chorded versions here.
		if (editTool === 'select' && session && (e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			copySelectionToClipboard(session, copyableIds(session, [...session.selectionIds]));
			return;
		}
		if (editTool === 'select' && session && (e.key === 'x' || e.key === 'X') && (e.ctrlKey || e.metaKey)
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			cutSelectionToClipboard(session);
			return;
		}
		if (editTool === 'select' && session && (e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void pasteAtWorld(session, lastPointerWorld ?? new Vec2(session.camera.center.x, session.camera.center.y));
			return;
		}
		if (editTool === 'select' && session && (e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			duplicateSelectedElements(session);
			return;
		}
		// Tool-switch hotkeys. R/T are already rotate/tidy below, so Rect and
		// Text stay button-only (no letter available without a collision).
		const hotkeyTool = EDIT_TOOL_HOTKEYS[e.key.toLowerCase()];
		if (!e.ctrlKey && !e.metaKey && !e.altKey && hotkeyTool) {
			e.preventDefault();
			setEditTool(hotkeyTool);
			return;
		}
		if (e.key === 'Escape') {
			if (symbolChooser.isOpen || editTool === 'place-symbol') {
				// Covers both the chooser being open AND the armed-but-not-
				// yet-clicked state (tool active, modal not open yet) —
				// cancelSymbolPlacement handles either safely.
				symbolChooser.cancelPlacement();
			}
			else if (!propertiesModalEl.classList.contains('hidden')) {
				closePropertiesModal();
			}
			else if (contextMenu.isOpen) {
				closeContextMenu();
			}
			else if (pendingShapeTracker.isActive) {
				resetEditToolState();
			}
			else {
				selectedRef = null;
				editSelectedId = null;
				editSelectedKind = null;
				session?.select(null);
			}
			return;
		}
		if ((e.key === 'Delete' || e.key === 'Backspace') && editTool === 'select' && session
			&& session.selectionIds.size > 0) {
			e.preventDefault();
			const s = session;
			const hitItems = s.activeScene?.hitTestItems ?? [];
			const allIds = [...s.selectionIds];
			// Symbols aren't deletable in edit mode (matches the single-select
			// rule this replaces) — deleteElements() itself has no such guard
			// (it's a caller-side convention only), so the filter has to happen
			// here, not there.
			const deletableIds = allIds.filter(id => hitItems.find(it => it.id === id)?.kind !== 'symbol');
			const skippedSymbols = allIds.length - deletableIds.length;
			const removed = deletableIds.length ? s.deleteElements(deletableIds) : 0;
			if (removed) {
				appState.refreshSchematicText(s);
			}
			if (skippedSymbols && !removed) {
				setStatus('Symbols aren\'t deletable in edit mode.');
			}
			else if (skippedSymbols) {
				setStatus(
					`Deleted ${ removed } item(s); ${ skippedSymbols } symbol(s) skipped (not deletable in edit mode).`);
			}
			else if (removed) {
				setStatus('Deleted.');
			}
			syncSingleSelectionBookkeeping(s);
			return;
		}
		if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			void rotateSelected();
			return;
		}
		if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			autoplaceSelectedFields();
			return;
		}
		return;
	}

	if (mode !== 'circuit' || !circuitDragMode) {
		return;
	}
	if (e.key === 'Escape') {
		selectedRef = null;
		session?.select(null);
		return;
	}
	if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		void rotateSelected();
	}
	if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		autoplaceSelectedFields();
	}
});

/** Tidy the selected component's Reference/Value labels (T) — re-place them
 *  beside the body, upright and clear of the wires. */
function autoplaceSelectedFields(): void {
	sessionController.tidySelectedFields();
}

// ---- Copy / Cut / Paste / Duplicate ----

/** Copy handler shared by Ctrl+C and the context menu's Copy — stores each
 *  copied element's source text AND its own original bbox position, so
 *  pasteClipboardAt can preserve the copied set's relative layout instead
 *  of stacking every pasted item at one point. Returns the count copied.
 *
 *  Also best-effort writes a real-KiCad-compatible text blob to the actual
 *  OS clipboard (session.copySelectionForSystemClipboard — same shape
 *  real KiCad's own Copy produces, confirmed against its source) so a
 *  copy here can be pasted directly into real KiCad. Deliberately
 *  fire-and-forget with a swallowed rejection: navigator.clipboard can be
 *  absent (non-secure context) or throw (permission denied), and none of
 *  that should ever break the in-app clipboard this function's caller
 *  actually depends on. */
function copySelectionToClipboard(s: KicadRenderSession, ids: string[]): number {
	const copied = s.copySelectionText(ids);
	const hitItems = s.activeScene?.hitTestItems ?? [];
	clipboard = copied.map(({ id, sourceText }) => {
		const item = hitItems.find(it => it.id === id);
		const anchor = pasteAnchor(item?.element);
		const bbox = item?.bbox;
		return { sourceText, x: anchor?.x ?? bbox?.x ?? 0, y: anchor?.y ?? bbox?.y ?? 0 };
	});
	const systemText = s.copySelectionForSystemClipboard(ids);
	if (systemText) {
		void navigator.clipboard?.writeText(systemText).catch(() => { /* best-effort only */ });
	}
	setStatus(clipboard.length ? `Copied ${ clipboard.length } item(s).` : 'Nothing to copy.');
	return clipboard.length;
}

/** Cut = copy the cuttable subset of the selection, then delete exactly that
 *  subset — reuses the Delete/Backspace handler's own "symbols aren't
 *  deletable in edit mode" skip-count message wording/shape. Deliberately
 *  does NOT copy-then-partially-delete the full selection: a symbol that
 *  can't be deleted also isn't copied, so a later Paste can't silently
 *  duplicate something that looked like it had just been "moved" out. */
function cutSelectionToClipboard(s: KicadRenderSession): void {
	const allIds = [...s.selectionIds];
	const hitItems = s.activeScene?.hitTestItems ?? [];
	const symbolCount = allIds.filter(id => hitItems.find(it => it.id === id)?.kind === 'symbol').length;
	const ids = cuttableIds(s, allIds);
	if (ids.length === 0) {
		setStatus(symbolCount ? 'Symbols aren\'t deletable in edit mode.' : 'Nothing to cut.');
		return;
	}
	copySelectionToClipboard(s, ids);
	const removed = s.deleteElements(ids);
	if (removed) {
		appState.refreshSchematicText(s);
	}
	syncSingleSelectionBookkeeping(s);
	setStatus(symbolCount
		? `Cut ${ removed } item(s); ${ symbolCount } symbol(s) skipped (not deletable in edit mode).`
		: `Cut ${ removed } item(s).`);
	updateEditSidebar();
}

/** Pastes the current clipboard anchored at targetWorld — the clipboard
 *  set's own combined top-left (min x/y across every copied item) maps to
 *  targetWorld; since every item then shares that SAME translation, each
 *  keeps its original offset from that anchor, preserving the copied set's
 *  relative layout instead of collapsing everything onto one point. */
function pasteClipboardAt(s: KicadRenderSession, targetWorld: Vec2): void {
	if (!clipboard.length) {
		return;
	}
	const anchorX = Math.min(...clipboard.map(c => c.x));
	const anchorY = Math.min(...clipboard.map(c => c.y));
	const dx = targetWorld.x - anchorX;
	const dy = targetWorld.y - anchorY;
	const newIds = s.pasteElements(clipboard.map(c => ({ sourceText: c.sourceText, dx, dy })));
	if (newIds.length === 0) {
		return;
	}
	s.selectMultiple(newIds, 'replace');
	syncSingleSelectionBookkeeping(s);
	appState.refreshSchematicText(s);
	setStatus(`Pasted ${ newIds.length } item(s).`);
	updateEditSidebar();
}

/** Entry point for every Paste gesture (Ctrl+V, context-menu Paste) — tries
 *  the REAL OS clipboard first (session.pasteSystemClipboardText, which
 *  understands real KiCad's own clipboard text shape) so content copied in
 *  real KiCad pastes directly into this app; falls back to the in-app
 *  clipboard array (pasteClipboardAt) when the OS clipboard is empty,
 *  inaccessible, or doesn't parse as KiCad content. Since a same-app
 *  Copy writes to BOTH the in-app array and the OS clipboard together,
 *  this order doesn't change behavior for in-app-only copy/paste — it
 *  only matters when the OS clipboard holds something this app didn't
 *  itself just put there. */
async function pasteAtWorld(s: KicadRenderSession, targetWorld: Vec2): Promise<void> {
	// Paste targets are placement anchors, so quantize them before either
	// clipboard path computes its translation. This also covers Ctrl+V when
	// the last pointer position was captured between grid ticks.
	const snappedTarget = new Vec2(snap(targetWorld.x), snap(targetWorld.y));
	let systemText: string | null = null;
	try {
		systemText = (await navigator.clipboard?.readText()) || null;
	}
	catch {
		systemText = null;
	}
	if (systemText) {
		const newIds = s.pasteSystemClipboardText(systemText, snappedTarget.x, snappedTarget.y);
		if (newIds.length > 0) {
			s.selectMultiple(newIds, 'replace');
			syncSingleSelectionBookkeeping(s);
			appState.refreshSchematicText(s);
			setStatus(`Pasted ${ newIds.length } item(s) from clipboard.`);
			updateEditSidebar();
			return;
		}
	}
	if (clipboard.length > 0) {
		pasteClipboardAt(s, snappedTarget);
	}
	else {
		setStatus('Nothing to paste.');
	}
}

/** Duplicate (Ctrl+D / context menu) — same copyableIds scope as Copy
 *  (sheets/sheet-pins excluded, symbols included), offset by
 *  duplicateSelection's own small fixed default so the copies don't land
 *  exactly on top of the originals. Selects the new items afterward. */
function duplicateSelectedElements(s: KicadRenderSession): void {
	const ids = copyableIds(s, [...s.selectionIds]);
	if (ids.length === 0) {
		return;
	}
	const newIds = s.duplicateSelection(ids);
	if (newIds.length === 0) {
		return;
	}
	s.selectMultiple(newIds, 'replace');
	syncSingleSelectionBookkeeping(s);
	appState.refreshSchematicText(s);
	setStatus(`Duplicated ${ newIds.length } item(s).`);
	updateEditSidebar();
}

// ---- Group / Ungroup ----
// Named groupSelectedElements/ungroupSelectedElements (never a bare
// "Group"-prefixed name) to stay clear of the unrelated TOOL_GROUPS/
// ToolGroupDef/cycleGroup identifiers already in this file for
// the cyclable-toolbar-button concept (Label/Shape tool groups) — same
// word, unrelated feature.

function groupSelectedElements(s: KicadRenderSession): void {
	const groupUuid = s.groupSelection([...s.selectionIds]);
	if (!groupUuid) {
		return;
	}
	appState.refreshSchematicText(s);
	setStatus('Grouped selection.');
	updateEditSidebar();
}

function ungroupSelectedElements(s: KicadRenderSession): void {
	const removed = s.ungroupSelection([...s.selectionIds]);
	if (removed === 0) {
		return;
	}
	appState.refreshSchematicText(s);
	setStatus(removed === 1 ? 'Ungrouped.' : `Ungrouped ${ removed } group(s).`);
	updateEditSidebar();
}

// ---- Edit mode: tool switching, text input, preview ----

/** Clear every in-progress edit-mode gesture (chain/anchor/points/drag/text)
 *  and the live preview — called on tool switch and on leaving edit mode. */
function resetEditToolState(): void {
	lineChainStart = null;
	shapeAnchor = null;
	arcPoints = [];
	bezierPoints = [];
	ruleAreaPoints = [];
	pendingShapeTracker.clear();
	editGestureTracker.end();
	pendingTableAnchor = null;
	pendingTableId = null;
	tableModal.classList.add('hidden');
	propertiesModalEl.classList.add('hidden');
	currentLabelShape = 'input';
	currentDirectiveLabelShape = 'round';
	hideTextInput();
	closeContextMenu();
	session?.setEditPreview(null);
}

function setEditTool(tool: EditTool): void {
	if (tool !== 'place-symbol') {
		symbolChooser.clearPlacement();
	}
	editTool = tool;
	resetEditToolState();
	toolbar.syncForTool(tool);
	for (const btn of editToolButtons) {
		btn.classList.toggle('active', btn.dataset.tool === tool);
	}
	updateCircuitHint();
}

function hideTextInput(): void {
	textInputFlow.reset();
	pendingTextAnchor = null;
	pendingTextBoxBounds = null;
	editingLabelId = null;
}

/** Live preview for whichever tool is driving the floating text input —
 *  mirrors what that tool's add*() method will actually commit, so there's
 *  no jump when it does. */
function previewForPendingText(anchor: Vec2, text: string): EditPreviewState | null {
	switch (editTool) {
		case 'text':
			return { kind: 'text', anchor, text };
		case 'label':
			return { kind: 'label', anchor, text, rotation: 0 };
		case 'directive-label':
			return { kind: 'directive-label', anchor, text, shape: currentDirectiveLabelShape, rotation: 0 };
		case 'global-label':
		case 'hier-label':
			return { kind: editTool, anchor, text, shape: currentLabelShape, rotation: 0 };
		case 'power':
			// Only reachable via the text-input flow when currentPowerKind is
			// 'rail' (gnd/flag are one-click, see handleEditModeMouseDown).
			return { kind: 'text', anchor, text };
		default:
			return null;
	}
}

function previewForPendingTextBox(text: string): EditPreviewState | null {
	if (!pendingTextBoxBounds) {
		return null;
	}
	return { kind: 'text-box', ...pendingTextBoxBounds, text };
}

/** Shared positioning/show logic for the floating text input, used by both
 *  tool placement (fresh element, clientX/Y come from the triggering mouse
 *  event) and the context menu's "Edit Text…" (existing element, clientX/Y
 *  derived from its world position instead — see showEditLabelInput). */
function showTextInputAt(
	worldAnchor: Vec2, clientX: number, clientY: number, placeholder: string, initialValue: string): void {
	pendingTextAnchor = worldAnchor;
	// clientX/clientY, NOT screenPosFromEvent()'s output — that's DPR-scaled
	// for canvas-buffer hit-testing and would misposition an HTML overlay.
	const stageRect = stage.getBoundingClientRect();
	editTextInput.style.left = `${ clientX - stageRect.left }px`;
	editTextInput.style.top = `${ clientY - stageRect.top }px`;
	editTextInput.value = initialValue;
	editTextInput.placeholder = placeholder;
	editTextInput.classList.remove('hidden');
	editTextInput.focus();
	if (initialValue) {
		editTextInput.select();
	}
	if (!editingLabelId) {
		session?.setEditPreview(previewForPendingText(worldAnchor, initialValue));
	}
}

function showTextInput(worldAnchor: Vec2, e: MouseEvent): void {
	textInputFlow.showText(worldAnchor, e, TEXT_INPUT_PLACEHOLDERS);
}

function showTextBoxInput(first: Vec2, second: Vec2, e: MouseEvent): void {
	textInputFlow.showTextBox(first, second, e);
}

function showTableModal(anchor: Vec2): void {
	textInputFlow.showTable(anchor);
}

function showTableEditModal(id: string): void {
	textInputFlow.showTableEditor(id);
}

/** Double-click-to-edit for every non-table kind — reuses whichever
 *  renderXProperties() function updateEditSidebar() would already dispatch
 *  to for this hit, just pointed at the modal body instead of the sidebar
 *  via the modal's own body. Selecting first (not just reading the hit) keeps
 *  this in lock-step with what a plain click already does, and means the
 *  sidebar naturally shows the same element once the modal closes.
 *
 *  Cleared BEFORE rendering (not just checked after) so a kind with no
 *  dedicated panel — updateEditSidebar()'s default case writes straight to
 *  editPropertiesEl, never touching the modal body — can't leave a STALE
 *  modal body from a previous, different double-click behind; children.length
 *  after the render is what decides whether a real panel exists to show. */
function showPropertiesModal(hitId: string): void {
	const s = session;
	if (!s) {
		return;
	}
	s.select(hitId);
	propertiesDialog.clear();
	propertiesDialog.setTitle('Properties');
	const hit = s.activeScene?.hitTestItems.find(item => item.id === hitId);
	const element = (hit as any)?.element;
	if (!hit || !element) {
		return;
	}
	const labelKind = (hit as any).labelKind as string | undefined;
	switch (hit.kind) {
		case 'symbol':
			propertyDialogRenderers.renderSymbol(element, hit.id);
			break;
		case 'symbol-graphic':
			propertyDialogRenderers.renderShape(element, hit.kind, hit.id);
			break;
		case 'wire':
		case 'bus':
			propertyDialogRenderers.renderWireBus(element, hit.kind, hit.id);
			break;
		case 'junction':
			propertyDialogRenderers.renderJunction(element, hit.id);
			break;
		case 'text':
			// Same gate as updateEditSidebar's own dispatch — table cells also
			// carry kind:'text' but have a wholly different property surface
			// (row/col span, per-cell margins) out of scope here either way.
			if (element.name === 'text' || element.name === 'text_box') {
				propertyDialogRenderers.renderText(element, hit.id);
			}
			break;
		case 'label':
			propertyDialogRenderers.renderLabel(element, labelKind, hit.id);
			break;
		default:
			break;
	}
	if (!propertiesDialog.body.children.length) {
		return;
	}
	propertiesDialog.show();
	updateUndoStackPane();
}

/** Refreshes the real sidebar on close
 *  editPropertiesEl by then) so it picks up whatever the modal's live edits
 *  left behind — the fields inside commit immediately on change, same as
 *  the sidebar's own fields, so there's nothing to "save" here. */
function closePropertiesModal(): void {
	propertiesDialog.close();
	updateEditSidebar();
}

document.getElementById('properties-modal-close')?.addEventListener('click', () => {
	closePropertiesModal();
});

/** Context menu's "Edit Text…" — reuses the floating text input to rename
 *  an EXISTING label in place, pre-filled with its current text, positioned
 *  at the label's own world position rather than wherever was right-clicked. */
function showEditLabelInput(id: string): void {
	textInputFlow.showEditLabel(id);
}

function commitTextInput(): void {
	const value = editTextInput.value.trim();
	if (editingLabelId) {
		const id = editingLabelId;
		if (value && session && session.renameLabel(id, value)) {
			appState.refreshSchematicText(session);
			setStatus('Renamed.');
		}
		hideTextInput(); // also clears editingLabelId
		session?.setEditPreview(null);
		return;
	}
	const anchor = pendingTextAnchor;
	if (!value || !anchor || !session) {
		hideTextInput();
		session?.setEditPreview(null);
		return;
	}
	switch (editTool) {
		case 'text':
			session.addGraphicText(anchor.x, anchor.y, value);
			setStatus(`Added text "${ value }".`);
			break;
		case 'label':
			session.addLabel(anchor.x, anchor.y, value);
			setStatus(`Added label "${ value }".`);
			break;
		case 'directive-label':
			session.addDirectiveLabel(anchor.x, anchor.y, value, currentDirectiveLabelShape);
			setStatus(`Added directive label "${ value }" (${ currentDirectiveLabelShape }).`);
			break;
		case 'global-label':
			session.addGlobalLabel(anchor.x, anchor.y, value, currentLabelShape);
			setStatus(`Added global label "${ value }" (${ currentLabelShape }).`);
			break;
		case 'hier-label':
			session.addHierLabel(anchor.x, anchor.y, value, currentLabelShape);
			setStatus(`Added hierarchical label "${ value }" (${ currentLabelShape }).`);
			break;
		case 'power':
			// Only reachable when currentPowerKind is 'rail' — gnd/flag commit
			// one-click in handleEditModeMouseDown and never open this input.
			session.addPowerRail(anchor.x, anchor.y, value);
			setStatus(`Added power rail "${ value }".`);
			break;
		default:
			break;
	}
	appState.refreshSchematicText(session);
	hideTextInput();
	session.setEditPreview(null);
}

function commitTextBoxInput(): void {
	const value = editTextBoxInput.value.trim();
	const bounds = pendingTextBoxBounds;
	if (value && bounds && session) {
		session.addGraphicTextBox(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height, value);
		appState.refreshSchematicText(session);
		setStatus('Added text box.');
	}
	hideTextInput();
	session?.setEditPreview(null);
}

// ---- Edit mode: right-click context menu ----

function closeContextMenu(): void {
	contextMenu.close();
}

canvas.addEventListener('contextmenu', (e) => {
	if (mode !== 'edit') {
		return;
	}
	e.preventDefault();
	syncPendingShapeTracker();
	// Right-click during an in-progress multi-click placement (wire/bus
	// chain, line/rect/circle anchor, arc points) ends it, same as Escape —
	// a context menu popping up mid-chain would be a worse UX than just
	// stopping, and matches KiCad's own right-click-to-finish convention.
	if (pendingShapeTracker.isActive) {
		resetEditToolState();
		return;
	}
	const s = ensureSession();
	const pointer = screenPosFromEvent(e);
	const hit = s.hitTestAtScreen(pointer);
	const selectedIds = [...s.selectionIds];
	const items = contextMenu.buildItems({
		session: s,
		hit,
		selectedIds,
		pointer: { x: pointer.x, y: pointer.y },
		screenToWorld: screen => s.screenToWorld(new Vec2(screen.x, screen.y)),
		toolButtons: editToolButtons.map(
			button => ({ id: button.id, title: button.title, disabled: button.disabled, tool: button.dataset.tool })),
		toolGroups: TOOL_GROUPS,
		labelShapes: LABEL_SHAPES,
		directiveLabelShapes: DIRECTIVE_LABEL_SHAPES,
		actions: {
			zoomToSelection: sessionToFit => {
				const selected = sessionToFit.activeScene?.hitTestItems.filter(
					item => sessionToFit.selectionIds.has(item.id)) ?? [];
				sessionToFit.fitToItems(selected);
			},
			align: (sessionToAlign, ids, axis) => {
				if (sessionToAlign.alignSelection(ids, axis)) {
					appState.refreshSchematicText(sessionToAlign);
					updateUndoStackPane();
					setStatus(`Aligned ${ ids.length } item(s).`);
				}
			},
			copy: (sessionToCopy, ids) => { copySelectionToClipboard(sessionToCopy, copyableIds(sessionToCopy, ids)); },
			cut: sessionToCut => cutSelectionToClipboard(sessionToCut),
			duplicate: sessionToDuplicate => duplicateSelectedElements(sessionToDuplicate),
			group: sessionToGroup => groupSelectedElements(sessionToGroup),
			ungroup: sessionToUngroup => ungroupSelectedElements(sessionToUngroup),
			paste: (sessionToPaste, world) => { void pasteAtWorld(sessionToPaste, new Vec2(world.x, world.y)); },
			setTool: tool => setEditTool(tool as EditTool),
			startImageInsertion,
			startSymbolPlacement: () => {
				setEditTool('place-symbol');
				setStatus('Click on canvas to choose where to place a symbol.');
			},
			rotate: (sessionToRotate, symbolHit) => {
				selectedRef = symbolHit.refDesignator;
				sessionToRotate.select(symbolHit.id);
				void rotateSelected();
			},
			tidyLabels: (sessionToTidy, symbolHit) => {
				selectedRef = symbolHit.refDesignator;
				sessionToTidy.select(symbolHit.id);
				autoplaceSelectedFields();
			},
			mirror: (sessionToMirror, id, axis) => {
				sessionToMirror.mutateSymbolByPaintId(
					id, symbol => { symbol.setMirror(symbol.getMirror() === axis ? null : axis); });
				appState.refreshSchematicText(sessionToMirror);
			},
			delete: (sessionToDelete, id) => {
				if (sessionToDelete.deleteElements([id])) {
					appState.refreshSchematicText(sessionToDelete);
					setStatus('Deleted.');
				}
			},
			editLabel: showEditLabelInput,
			cycleLabelShape: (sessionToCycle, labelHit, shapes) => {
				const element = (sessionToCycle as any).schScene?.hitTestItems?.find(
					(item: any) => item.id === labelHit.id)?.element;
				if (!element || typeof element.getShape !== 'function') {
					return;
				}
				const current = element.getShape();
				const next = shapes[(shapes.indexOf(current) + 1) % shapes.length]!;
				if (sessionToCycle.setLabelShape(
					labelHit.id, next as KicadGlobalLabelShape | KicadDirectiveLabelShape)) {
					appState.refreshSchematicText(sessionToCycle);
					setStatus(`Shape: ${ next }.`);
				}
			}
		}
	});
	contextMenu.show(items, e.clientX, e.clientY);
});

window.addEventListener('click', (e) => {
	if (!propertiesModalEl.classList.contains('hidden') && !propertiesModalEl.contains(e.target as Node)) {
		closePropertiesModal();
	}
});

function updateEditPreview(s: KicadRenderSession, cursor: Vec2): void {
	let preview: EditPreviewState | null;
	switch (editTool) {
		case 'wire':
		case 'bus':
			// Bus reuses the wire preview kind — every tool already uses one flat
			// ghost color regardless of the committed element's real styling.
			preview = lineChainStart ? { kind: 'wire', from: lineChainStart, cursor } : null;
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
			preview = { kind: editTool, anchor: shapeAnchor, cursor };
			break;
		case 'text-box':
			preview = shapeAnchor
				? {
					kind: 'text-box', x: Math.min(shapeAnchor.x, cursor.x), y: Math.min(shapeAnchor.y, cursor.y),
					width: Math.abs(cursor.x - shapeAnchor.x), height: Math.abs(cursor.y - shapeAnchor.y), text: ''
				}
				: null;
			break;
		case 'arc':
			preview = { kind: 'arc', points: arcPoints, cursor };
			break;
		case 'bezier':
			preview = { kind: 'bezier', points: bezierPoints, cursor };
			break;
		case 'rule-area':
			preview = { kind: 'rule-area', points: ruleAreaPoints, cursor };
			break;
		case 'power':
			// One-click gnd/flag get a mouse-follow marker like junction/no-connect;
			// rail commits via the text-input flow (no mouse-follow preview,
			// matching the label/text tools' own pre-click behavior).
			preview = currentPowerKind !== 'rail' ? { kind: 'power', cursor } : null;
			break;
		default:
			preview = null;
	}
	s.setEditPreview(preview);
}

/**
 * Edit mode's per-tool click handler. Returns true if the click was fully
 * handled (caller must NOT fall through to canvas panning) — false only for
 * the select tool clicking empty space, matching circuit mode's own
 * hit-then-fallthrough-to-pan convention.
 */
function handleEditModeMouseDown(e: MouseEvent, s: KicadRenderSession, screenPos: Vec2): boolean {
	const worldPos = s.screenToWorld(screenPos);
	lastPointerWorld = worldPos;
	const snapped = new Vec2(snap(worldPos.x), snap(worldPos.y));
	const samePoint = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;

	if (editTool === 'select') {
		// Selection and drag start are primary-button actions only. Returning
		// false lets middle-button input continue to the canvas pan path and
		// prevents it from unexpectedly changing selection under the cursor.
		if (e.button !== 0) {
			return false;
		}
		const curveAnchor = curveAnchorAtScreen(s, screenPos);
		if (curveAnchor) {
			selectedRef = null;
			editSelectedId = curveAnchor.curve.id;
			editSelectedKind = 'curve';
			s.pushUndoSnapshot();
			editGestureTracker.begin({ kind: 'curve', id: curveAnchor.curve.id, anchor: curveAnchor.anchor });
			e.preventDefault();
			return true;
		}
		// Resize handles belong to the existing selection and sit above ordinary
		// hit-testing. The center handle deliberately routes through the same
		// delta-based drag used by every movable edit object.
		const resizeHandle = resizeHandleAtScreen(s, screenPos);
		if (resizeHandle) {
			selectedRef = null;
			editSelectedId = resizeHandle.box.id;
			editSelectedKind = 'resize-box';
			s.pushUndoSnapshot();
			if (resizeHandle.handle === 'center') {
				editGestureTracker.begin({ kind: 'element', id: resizeHandle.box.id, lastSnapped: snapped });
			}
			else {
				editGestureTracker.begin({
					kind: 'resize',
					id: resizeHandle.box.id,
					handle: resizeHandle.handle,
					original: resizeHandle.box
				});
			}
			e.preventDefault();
			return true;
		}
		const hit = s.hitTestAtScreen(screenPos);
		const clickSelectMode = rectSelectionModeFromModifiers(e);
		if (hit && clickSelectMode !== 'replace') {
			// Modifier-click on an item: toggle its membership only, uniformly
			// across every hit kind, never starting a drag — a modifier-click
			// means "adjust the selection," not "move something," regardless
			// of whether the clicked item ends up in or out of the selection
			// afterward.
			s.selectMultiple([hit.id], clickSelectMode);
			syncSingleSelectionBookkeeping(s);
			e.preventDefault();
			return true;
		}
		if (hit) {
			const expanded = s.expandGroupSelection([hit.id]);
			if (expanded.length > 1) {
				// Fresh click on an item belonging to an existing group, not yet
				// the active selection: select the WHOLE group and start a
				// group-drag immediately, same as the already-multi-selected
				// case right below — otherwise a plain click on an unselected
				// group member would visually highlight the whole group but
				// only drag the one clicked item.
				s.selectMultiple(expanded, 'replace');
				syncSingleSelectionBookkeeping(s);
				editGestureTracker.begin({ kind: 'group', lastSnapped: snapped });
				dragMoved = false;
				e.preventDefault();
				return true;
			}
		}
		if (hit && s.selectionIds.size > 1 && s.selectionIds.has(hit.id)) {
			// Plain click-drag on an item that's already part of a real
			// multi-selection: move the WHOLE group together rather than
			// collapsing to just this one (which is what every kind-specific
			// branch below would otherwise do via its own s.select(hit.id)).
			// A plain click on something NOT already selected still falls
			// through to those branches as normal — only an already-selected
			// item preserves the group.
			editGestureTracker.begin({ kind: 'group', lastSnapped: snapped });
			dragMoved = false;
			e.preventDefault();
			return true;
		}
		if (hit?.kind === 'symbol' && hit.refDesignator) {
			selectedRef = hit.refDesignator;
			editSelectedId = hit.id;
			editSelectedKind = hit.kind;
			s.select(hit.id);
			beginEditSymbolDrag(hit.refDesignator, hit.id, screenPos);
			e.preventDefault();
			return true;
		}
		if (hit?.kind === 'sheet') {
			selectedRef = null;
			editSelectedId = hit.id;
			editSelectedKind = hit.kind;
			s.select(hit.id);
			beginSheetDrag(hit.id, screenPos);
			e.preventDefault();
			return true;
		}
		if (hit?.kind === 'label' && hit.labelKind === 'sheet-pin') {
			// Must be checked before the generic `if (hit)` fallback below:
			// a sheet pin has kind:'label' like any other label, but needs
			// moveSheetPinById's edge-constrained drag, not
			// translateElementById's free relative move.
			selectedRef = null;
			editSelectedId = hit.id;
			editSelectedKind = hit.kind;
			s.select(hit.id);
			beginSheetPinDrag(hit.id, screenPos);
			e.preventDefault();
			return true;
		}
		if (hit?.kind === 'label') {
			// Labels have an absolute attach point. Delta-translating an already
			// off-grid label preserves the error forever, so use the same
			// absolute, snapped drag path as circuit-mode labels.
			selectedRef = null;
			editSelectedId = hit.id;
			editSelectedKind = hit.kind;
			s.select(hit.id);
			s.pushUndoSnapshot();
			const element = (s as any).schScene?.hitTestItems?.find((item: any) => item.id === hit.id)?.element;
			const origin = element?.getOrigin?.() ?? worldPos;
			dragMoved = false;
			dragStartPose = { x: origin.x, y: origin.y, rotation: origin.rotation ?? 0 };
			dragOffset = new Vec2(worldPos.x - origin.x, worldPos.y - origin.y);
			editGestureTracker.begin({ kind: 'label', id: hit.id, offset: dragOffset, startPose: dragStartPose });
			e.preventDefault();
			return true;
		}
		if (hit) {
			// Non-label elements use the incremental delta drag path.
			selectedRef = null;
			editSelectedId = hit.id;
			editSelectedKind = hit.kind;
			s.select(hit.id);
			s.pushUndoSnapshot();
			editGestureTracker.begin({ kind: 'element', id: hit.id, lastSnapped: snapped });
			e.preventDefault();
			return true;
		}
		// Empty space: start a rectangle-select drag rather than clearing
		// immediately — selection itself is deferred entirely to mouseup (see
		// onPointerUp's rectangle-select branch), so an in-progress modifier
		// change doesn't produce an inconsistent intermediate state. Every
		// OTHER edit-mode tool already returns true unconditionally here with
		// no left-drag-pan, so this makes the select tool consistent with the
		// rest rather than newly inconsistent — middle-drag/wheel-zoom still
		// pan/zoom regardless.
		editGestureTracker.begin({ kind: 'rect-select', originWorld: worldPos, originScreen: screenPos });
		dragMoved = false;
		e.preventDefault();
		return true;
	}

	if (editTool === 'wire' || editTool === 'bus') {
		if (!lineChainStart) {
			lineChainStart = snapped;
		}
		else if (samePoint(snapped, lineChainStart)) {
			lineChainStart = null;
			s.setEditPreview(null);
		}
		else {
			if (editTool === 'wire') {
				s.addWire(lineChainStart.x, lineChainStart.y, snapped.x, snapped.y);
			}
			else {
				s.addBus(lineChainStart.x, lineChainStart.y, snapped.x, snapped.y);
			}
			appState.refreshSchematicText(s);
			lineChainStart = snapped;
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'bus-entry') {
		s.addBusEntry(snapped.x, snapped.y);
		appState.refreshSchematicText(s);
		e.preventDefault();
		return true;
	}

	if (editTool === 'junction') {
		s.addJunction(snapped.x, snapped.y);
		appState.refreshSchematicText(s);
		e.preventDefault();
		return true;
	}

	if (editTool === 'no-connect') {
		s.addNoConnect(snapped.x, snapped.y);
		appState.refreshSchematicText(s);
		e.preventDefault();
		return true;
	}

	if (editTool === 'place-symbol') {
		if (e.button === 0) {
			symbolChooser.placeAt(snapped);
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'image') {
		if (!pendingImagePayload) {
			setStatus('Choose an image file first.');
			startImageInsertion();
		}
		else {
			const payload = pendingImagePayload;
			pendingImagePayload = null;
			insertImageAt(payload, snapped);
			setEditTool('select');
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'line' || editTool === 'rect' || editTool === 'circle' || editTool === 'text-box') {
		if (!shapeAnchor) {
			shapeAnchor = snapped;
		}
		else if (samePoint(snapped, shapeAnchor)) {
			shapeAnchor = null;
			s.setEditPreview(null);
		}
		else {
			if (editTool === 'text-box') {
				const anchor = shapeAnchor;
				shapeAnchor = null;
				showTextBoxInput(anchor, snapped, e);
			}
			else if (editTool === 'line') {
				s.addGraphicLine(shapeAnchor.x, shapeAnchor.y, snapped.x, snapped.y);
			}
			else if (editTool === 'rect') {
				s.addGraphicRect(shapeAnchor.x, shapeAnchor.y, snapped.x, snapped.y);
			}
			else {
				const radius = Math.hypot(snapped.x - shapeAnchor.x, snapped.y - shapeAnchor.y);
				s.addGraphicCircle(shapeAnchor.x, shapeAnchor.y, radius);
			}
			appState.refreshSchematicText(s);
			shapeAnchor = null;
			s.setEditPreview(null);
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'table') {
		showTableModal(snapped);
		e.preventDefault();
		return true;
	}

	if (editTool === 'arc') {
		if (arcPoints.length === 0) {
			arcPoints = [snapped];
		}
		else if (arcPoints.length === 1) {
			if (samePoint(snapped, arcPoints[0]!)) {
				arcPoints = [];
				s.setEditPreview(null);
			}
			else {
				arcPoints = [arcPoints[0]!, snapped];
			}
		}
		else {
			const [start, end] = arcPoints;
			s.addGraphicArc(start!.x, start!.y, snapped.x, snapped.y, end!.x, end!.y);
			appState.refreshSchematicText(s);
			arcPoints = [];
			s.setEditPreview(null);
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'bezier') {
		if (bezierPoints.length < 4) {
			if (bezierPoints.length > 0 && samePoint(snapped, bezierPoints[bezierPoints.length - 1]!)) {
				bezierPoints = [];
				s.setEditPreview(null);
			}
			else {
				bezierPoints = [...bezierPoints, snapped];
				if (bezierPoints.length === 4) {
					s.addGraphicBezier(bezierPoints.map(point => ({ x: point.x, y: point.y })));
					appState.refreshSchematicText(s);
					bezierPoints = [];
					s.setEditPreview(null);
				}
			}
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'rule-area') {
		if (ruleAreaPoints.length >= 3 && samePoint(snapped, ruleAreaPoints[0]!)) {
			s.addRuleArea(ruleAreaPoints.map(point => ({ x: point.x, y: point.y })));
			appState.refreshSchematicText(s);
			ruleAreaPoints = [];
			s.setEditPreview(null);
		}
		else {
			if (!ruleAreaPoints.length || !samePoint(snapped, ruleAreaPoints[ruleAreaPoints.length - 1]!)) {
				ruleAreaPoints = [...ruleAreaPoints, snapped];
			}
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'power' && currentPowerKind === 'rail') {
		showTextInput(snapped, e);
		e.preventDefault();
		return true;
	}

	if (TEXT_INPUT_TOOLS.has(editTool)) {
		showTextInput(snapped, e);
		e.preventDefault();
		return true;
	}

	if (editTool === 'power') {
		if (currentPowerKind === 'gnd') {
			s.addPowerGnd(snapped.x, snapped.y);
			setStatus('Added GND.');
		}
		else {
			s.addPowerFlag(snapped.x, snapped.y);
			setStatus('Added PWR_FLAG.');
		}
		appState.refreshSchematicText(s);
		e.preventDefault();
		return true;
	}

	if (editTool === 'delete') {
		const hit = s.hitTestAtScreen(screenPos);
		if (hit) {
			if (hit.kind === 'symbol') {
				setStatus('Symbols aren\'t deletable in edit mode.');
			}
			else {
				const removed = s.deleteElements([hit.id]);
				if (removed) {
					appState.refreshSchematicText(s);
					setStatus('Deleted.');
				}
			}
		}
		// Always handled — a dedicated delete cursor shouldn't also pan,
		// matching junction/no-connect's own always-handled convention.
		e.preventDefault();
		return true;
	}

	return false;
}

window.addEventListener('resize', () => resizeCanvas());
stage.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('paste', (event) => {
	if (mode !== 'edit' || !session || session.documentTypeLoaded !== 'schematic') {
		return;
	}
	const target = event.target as HTMLElement | null;
	if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
		return;
	}
	const imageItem = Array.from(event.clipboardData?.items ?? []).find(item => item.type.startsWith('image/'));
	const file = imageItem?.getAsFile();
	if (!file) {
		return;
	}
	event.preventDefault();
	void readEmbeddedImage(file)
		.then(payload => {
			const center = lastPointerWorld ?? new Vec2(session!.camera.center.x, session!.camera.center.y);
			insertImageAt(payload, new Vec2(snap(center.x), snap(center.y)));
		})
		.catch(err => setStatus(err instanceof Error ? err.message : String(err)));
});
stage.addEventListener('drop', (e) => {
	e.preventDefault();
	const file = e.dataTransfer?.files?.[0];
	if (!file) {
		return;
	}
	void openKiCadFile(file);
});

gridSelectEl.value = String(settings.current.gridSpacingMm);
setMode('view');
ensureSession();
resizeCanvas();
void refreshSymbolLibraryButton();
updateStatusBar();
