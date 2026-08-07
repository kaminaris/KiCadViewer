import {
	KicadRenderSession,
	type EditPreviewState,
	type KicadGlobalLabelShape,
	type KicadDirectiveLabelShape,
	type ResizeHandle,
	type SelectionResizeBox,
	type CurveAnchor,
	type SelectionCurveAnchors,
	type AlignAxis,
} from '@kicad-render/KicadRenderSession';
import { Vec2 } from '@kicad-render/math/Vec2';
import { BBox } from '@kicad-render/math/BBox';
import { FINE_GRID_MM } from '@kicad-layout/Geometry';
import {
	applyLockedPinNets,
	isEditablePowerPlacement,
	lockNetlistFromSchematic,
	pinsForLockedLib,
	placeFromInputs,
	rewireSchematic,
	symbolFieldLayout,
	wrapFullSchematic,
	type CircuitDesignRecipe,
	type CircuitPlacement,
	type LockedNetlist,
} from '@kicad-layout/index';
import { reroute } from '@kicad-layout/Reroute';
import {
	SymbolLibraryCache,
	type CachedSymbolFile,
	type CachedSymbolSummary,
	type SymbolDirectoryHandle,
	type SymbolLibraryProgress,
	type SymbolLibrarySummary,
} from './SymbolLibraryCache';

type AppMode = 'view' | 'circuit' | 'edit';
type EditTool =
	| 'select' | 'place-symbol' | 'wire' | 'bus' | 'bus-entry' | 'junction' | 'no-connect' | 'line' | 'rect' | 'circle' | 'arc' | 'text'
	| 'text-box' | 'table' | 'rule-area' | 'bezier' | 'image' | 'label' | 'directive-label' | 'global-label' | 'hier-label' | 'power' | 'delete';

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
	h: 'hier-label',
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
/** Inner markup for the power tool button's <svg> — swapped by variant so
 *  right-click-cycling shows what's actually loaded, mirroring each kind's
 *  real glyph shape (ground rungs / diamond flag / up-arrow rail). Setting
 *  .innerHTML on the <svg> itself, never the <button> (that would nuke the
 *  <svg> wrapper too, not just its content). */
const POWER_KIND_ICONS: Record<PowerKind, string> = {
	gnd: '<path d="M12 4 V10"/><path d="M7 10 H17 M8.5 13 H15.5 M10.5 16 H13.5"/>',
	flag: '<path d="M12 18 V12"/><path d="M8 12 L12 8 L16 12 L12 16 Z"/>',
	rail: '<path d="M12 18 V6 M7 11 L12 6 L17 11"/>',
};

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
		{ tool: 'label', menuLabel: 'Label: Local',
			title: 'Label: Local — right-click to cycle Local/Directive/Global/Hierarchical',
			icon: '<path d="M4 8 H15 L19 12 L15 16 H4 Z"/>' },
		{ tool: 'directive-label', menuLabel: 'Label: Directive',
			title: 'Label: Directive (netclass flag) — right-click to cycle · Tab cycles shape while placing',
			icon: '<path d="M9 4 H15 L19 12 L15 20 H9 L5 12 Z"/>' },
		{ tool: 'global-label', menuLabel: 'Label: Global (G)',
			title: 'Label: Global (G) — right-click to cycle · Tab cycles shape while placing',
			icon: '<path d="M4 12 L7 8 H17 L20 12 L17 16 H7 Z"/>' },
		{ tool: 'hier-label', menuLabel: 'Label: Hierarchical (H)',
			title: 'Label: Hierarchical (H) — right-click to cycle · Tab cycles shape while placing',
			icon: '<path d="M4 8 L7 12 L4 16 H14 L20 12 L14 8 Z"/>' },
	],
};
const SHAPE_GROUP: ToolGroupDef = {
	buttonId: 'btn-shape-tool',
	members: [
		{ tool: 'line', menuLabel: 'Line (L)', title: 'Line (L)', icon: '<path d="M4 18 L20 6"/>' },
		{ tool: 'rect', menuLabel: 'Rectangle', title: 'Rectangle', icon: '<rect x="5" y="6" width="14" height="12"/>' },
		{ tool: 'circle', menuLabel: 'Circle (C)', title: 'Circle (C)', icon: '<circle cx="12" cy="12" r="7"/>' },
		{ tool: 'arc', menuLabel: 'Arc (A)', title: 'Arc (A)', icon: '<path d="M5 16 A10 10 0 0 1 19 10"/>' },
		{ tool: 'bezier', menuLabel: 'Bezier Curve (B)', title: 'Bezier Curve (B)', icon: '<path d="M4 18 C 8 6, 16 18, 20 6"/>' },
	],
};
const TOOL_GROUPS: ToolGroupDef[] = [LABEL_GROUP, SHAPE_GROUP];

/** Tools that place via the floating text input (vs. one-click commit).
 *  'power' is a one-click tool UNLESS currentPowerKind === 'rail' — handled
 *  as an extra condition alongside this set, not a static membership. */
const TEXT_INPUT_TOOLS: ReadonlySet<EditTool> = new Set(['text', 'label', 'directive-label', 'global-label', 'hier-label']);

const TEXT_INPUT_PLACEHOLDERS: Partial<Record<EditTool, string>> = {
	text: 'Text…',
	label: 'Net name…',
	'directive-label': 'Netclass name…',
	'global-label': 'Global label…',
	'hier-label': 'Hierarchical label…',
	power: 'Voltage (e.g. +3.3V)…',
};

/** Snap-to-grid spacing (mm) — user-adjustable via #grid-select, which also
 *  keeps the visible grid dots in sync (session.setGridSpacing()). */
let PLACE_GRID = FINE_GRID_MM;
const DEBUG = true;
/** Screen-pixel distance before a rectangle-select mousedown counts as a
 *  drag rather than a click — the box is unsnapped, so the existing
 *  world-snapped dragMoved idiom doesn't apply here. */
const RECT_SELECT_MOVE_THRESHOLD_PX = 4;

const statusEl = document.getElementById('status')!;
const scoreEl = document.getElementById('score')!;
const hintEl = document.getElementById('hint')!;
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
const editHierarchyEl = document.getElementById('edit-hierarchy')!;
const editUndoStackEl = document.getElementById('edit-undo-stack')!;
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
const propertiesModalTitleEl = document.getElementById('properties-modal-title') as HTMLHeadingElement;
const propertiesModalBodyEl = document.getElementById('properties-modal-body') as HTMLDivElement;
const contextMenuEl = document.getElementById('context-menu') as HTMLDivElement;
const coordStatusEl = document.getElementById('coord-status')!;
const gridSelectEl = document.getElementById('grid-select') as HTMLSelectElement;
const zoomStatusEl = document.getElementById('zoom-status')!;
const symbolChooserEl = document.getElementById('symbol-chooser-modal') as HTMLDivElement;
const symbolChooserTitleEl = document.getElementById('symbol-chooser-title') as HTMLHeadingElement;
const symbolChooserFilterEl = document.getElementById('symbol-chooser-filter') as HTMLInputElement;
const symbolChooserListEl = document.getElementById('symbol-chooser-list') as HTMLDivElement;
const symbolChooserDetailsEl = document.getElementById('symbol-preview-details') as HTMLDivElement;
const symbolPreviewArtEl = document.getElementById('symbol-preview-art') as HTMLDivElement;
const symbolPreviewCanvasEl = document.getElementById('symbol-preview-canvas') as HTMLCanvasElement;
const symbolPreviewPlaceholderEl = document.getElementById('symbol-preview-placeholder') as HTMLSpanElement;
/** Lazily created — a second, throwaway KicadRenderSession bound to the
 *  preview canvas, entirely separate from the main document's session.
 *  Reused across preview updates (not recreated per symbol) so switching
 *  the selected row doesn't pay session-construction cost every time. */
let symbolPreviewSession: KicadRenderSession | null = null;
/** Guards against a stale, slow readCachedFile() response clobbering a
 *  newer selection — e.g. user arrows down through rows faster than the
 *  IndexedDB reads resolve; only the LATEST request's result may render. */
let symbolPreviewRequestId = 0;
const symbolChooserOkEl = document.getElementById('symbol-chooser-ok') as HTMLButtonElement;
const symbolChooserCancelEl = document.getElementById('symbol-chooser-cancel') as HTMLButtonElement;
const symbolChooserCloseEl = document.getElementById('symbol-chooser-close') as HTMLButtonElement;
const symbolRepeatCopiesEl = document.getElementById('symbol-repeat-copies') as HTMLInputElement;
const symbolAllUnitsEl = document.getElementById('symbol-all-units') as HTMLInputElement;
const editToolButtons = Array.from(
	document.querySelectorAll<HTMLButtonElement>('#tool-panel [data-tool]')
);

// The canvas editor listens for pointer gestures higher in the document.
// Inspector controls must be an interaction island: otherwise a checkbox
// click is interpreted as a canvas pointer-up, which rebuilds the inspector
// and immediately steals focus/rolls the control back.
for (const eventName of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick']) {
	editPropertiesEl.addEventListener(eventName, event => event.stopPropagation());
	// The properties modal reuses the exact same field builders (propertyRow
	// etc.), so it needs the exact same interaction-island treatment — a
	// checkbox/select/color click inside it must not reach window's own
	// mousemove/mouseup drag-tracking listeners.
	propertiesModalEl.addEventListener(eventName, event => event.stopPropagation());
	symbolChooserEl.addEventListener(eventName, event => event.stopPropagation());
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
let lastFullSch = '';
/** Locked pin↔net map from the opened schematic (recipe-free rewire). */
let lockedNetlist: LockedNetlist | null = null;
let selectedRef: string | null = null;
let rerouting = false;

let draggingPan = false;
let dragStart = new Vec2(0, 0);
/** Symbol ref being dragged — circuit mode (auto-rewire on drop) OR edit
 *  mode's select tool (manual move, no rewire); mode alone disambiguates. */
let dragRef: string | null = null;
/** Edit mode only — the specific unit-instance's paint id, alongside
 *  dragRef. Several placed instances can share one Reference (multi-unit
 *  parts, e.g. five "U1"s), so dragRef alone can't tell them apart; this is
 *  always null in circuit mode, where a placements-array ref is already
 *  unique on its own. */
let dragInstanceId: string | null = null;
/** Global / hierarchical label being dragged (local labels are regenerated). */
let dragLabelId: string | null = null;
/** Hierarchical sheet box being dragged — absolute-position like dragRef
 *  (shares dragOffset/dragStartPose with it), not editDragId's relative-
 *  delta translateElementById path: moving a sheet must ALSO shift its
 *  properties and pins by the same amount (see moveSheetById's doc
 *  comment), which a single-point relative translate can't express. */
let dragSheetId: string | null = null;
/** Sheet pin being dragged — also absolute-position (shares dragOffset/
 *  dragStartPose), and MUST be intercepted before editDragId's generic
 *  label-drag path: a sheet pin has kind:'label' like any other label, but
 *  translateElementById's generic getOrigin/setOrigin fallback would move
 *  it freely with no edge-constraint, unlike moveSheetPinById's real-KiCad-
 *  ported ConstrainOnEdge behavior (see its doc comment). */
let dragSheetPinId: string | null = null;
let dragOffset = new Vec2(0, 0);
let dragMoved = false;
let dragUndoCaptured = false;
let dragStartPose: { x: number; y: number; rotation: number } | null = null;

// ---- Edit mode: hand-drawn wires/junctions/no-connects/graphics ----
let editTool: EditTool = 'select';
type PendingSymbol = { file: CachedSymbolFile; summary: CachedSymbolSummary; libId: string };
let pendingSymbol: PendingSymbol | null = null;
let symbolChooserRows: PendingSymbol[] = [];
/** World position the user clicked to trigger the chooser — the tool arms
 *  on toolbar/menu click, then the FIRST canvas click both picks the
 *  placement point AND opens the chooser (so the user can see where it'll
 *  land before choosing what goes there); OK places at this remembered
 *  point rather than requiring a second click. Not used for repeat-mode's
 *  subsequent placements, which place directly at each new click without
 *  reopening the chooser. */
let pendingSymbolAnchor: Vec2 | null = null;
/** Tracks an in-progress sequential (one-unit-per-click) multi-unit
 *  placement — set after placing unit N of a symbol whose total unit count
 *  is > 1, cleared once the last unit is placed or placement is abandoned.
 *  Keyed by libId so switching to a different symbol mid-sequence is
 *  detected as unrelated (see beginPendingSymbolPlacement) rather than
 *  continuing the wrong part's unit numbering. */
let pendingUnitState: { libId: string; reference: string; nextUnit: number; totalUnits: number } | null = null;
/** Wire/bus tools: last committed chain point (world, snapped), or null if no chain in progress. */
let lineChainStart: Vec2 | null = null;
/** Line/rect/circle/text-box tools: first-click anchor, or null before it. */
let shapeAnchor: Vec2 | null = null;
/** Arc tool: 0, 1 ([start]), or 2 ([start, end]) points clicked so far. */
let arcPoints: Vec2[] = [];
/** Bezier tool: 0..4 points (start, control 1, control 2, end). */
let bezierPoints: Vec2[] = [];
let ruleAreaPoints: Vec2[] = [];
/** Select tool: non-symbol element (wire/junction/no-connect/graphic/text) being dragged. */
let editDragId: string | null = null;
let editDragLastPos: Vec2 | null = null;
/** An outer selection handle is being dragged. The center handle uses the
 * ordinary editDrag path, since its contract is exactly "move this item". */
let resizeDrag: { id: string; handle: Exclude<ResizeHandle, 'center'>; original: SelectionResizeBox } | null = null;
let curveDrag: { id: string; anchor: CurveAnchor } | null = null;
/** Select tool: rectangle multi-select drag in progress from empty space —
 *  origin is fixed at mousedown, deliberately unsnapped (raw world coords,
 *  matching real KiCad's own selection box, unlike every placement tool's
 *  grid-snapped preview). */
let rectSelectDrag: { originWorld: Vec2; originScreen: Vec2 } | null = null;
/** Select tool: dragging the WHOLE current multi-selection together, started
 *  by a plain (no-modifier) mousedown on an item that's already part of a
 *  2+ item selection. lastSnapped is the cursor's own snapped world
 *  position, re-anchored every mousemove — the per-step delta from it is
 *  what actually moves every selected item (see translateSelection), same
 *  incremental technique editDragId already uses for a single item. */
let groupDrag: { lastSnapped: Vec2 } | null = null;
/** Select tool: paint-item id/kind of whatever's currently selected (for Delete-key policy). */
let editSelectedId: string | null = null;
let editSelectedKind: string | null = null;
/** Where propertySection()/the renderXProperties() family currently append —
 *  the sidebar by default, temporarily swapped to the properties-modal body
 *  by showPropertiesModal() so the exact same render functions can target
 *  either surface. Always reset back to editPropertiesEl synchronously right
 *  after the one render call that needs the swap — nothing else reads this
 *  mid-render, so there's no window where a concurrent call could observe
 *  the wrong target. */
let propertyTargetEl: HTMLElement = editPropertiesEl;
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
let currentPowerKind: PowerKind = 'gnd';

function dbg(...args: unknown[]): void {
	if (DEBUG) {
		console.log('[kicad-viewer]', ...args);
	}
}

function setStatus(msg: string): void {
	statusEl.textContent = msg;
}

function symbolSummaryLabel(summary: SymbolLibrarySummary): string {
	const errors = summary.errorCount ? `, ${summary.errorCount} failed` : '';
	return `Indexed ${summary.symbolCount} symbols from ${summary.fileCount} files${errors}.`;
}

function reportSymbolIndexProgress(progress: SymbolLibraryProgress): void {
	const total = progress.totalFiles ? `/${progress.totalFiles}` : '';
	const suffix = progress.error ? ` — ${progress.error}` : ` — ${progress.symbolCount} symbols`;
	setStatus(`Indexing symbols ${progress.processedFiles}${total}: ${progress.fileName}${suffix}`);
}

async function refreshSymbolLibraryButton(): Promise<void> {
	try {
		const summary = await symbolLibraryCache.getSummary();
		if (summary) {
			indexSymbolsButton.title = `${symbolSummaryLabel(summary)} Click to rescan.`;
		}
	}
	catch {
		// IndexedDB may be disabled by a private browsing policy; indexing will
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
		indexSymbolsButton.title = `${symbolSummaryLabel(summary)} Click to rescan.`;
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
		indexSymbolsButton.title = `${symbolSummaryLabel(summary)} Click to rescan.`;
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

function symbolLibraryId(file: CachedSymbolFile, symbol: CachedSymbolSummary): string {
	if (symbol.name.includes(':')) return symbol.name;
	const library = file.name.replace(/\.kicad_sym$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'Library';
	return `${ library }:${ symbol.name }`;
}

/** Real render, not a placeholder glyph: loads the symbol's own source into
 *  a scratch KicadRenderSession bound to a small preview canvas, places it
 *  at the origin via the same addLibrarySymbolFromText() the actual
 *  placement flow uses, fits the camera to its rendered bounds, and draws
 *  it — reusing the exact rendering pipeline already proven correct for
 *  the main canvas rather than a second, parallel drawing implementation. */
async function renderSymbolChooserPreview(item: PendingSymbol | null): Promise<void> {
	const requestId = ++symbolPreviewRequestId;
	if (!item) {
		symbolPreviewCanvasEl.classList.add('hidden');
		symbolPreviewPlaceholderEl.textContent = 'Select a symbol to preview';
		symbolPreviewPlaceholderEl.classList.remove('hidden');
		symbolChooserDetailsEl.textContent = '';
		symbolChooserOkEl.disabled = true;
		return;
	}
	const { summary } = item;
	const reference = summary.reference || 'U';
	symbolChooserDetailsEl.innerHTML = `<div class="detail-title">${summary.name}</div><div class="detail-muted">${summary.description || 'No description available.'}</div><br>Reference: ${reference}\nUnits: ${summary.units}\nKeywords: ${summary.keywords || '—'}\nLibrary: ${item.file.relativePath}`;
	symbolChooserOkEl.disabled = false;

	symbolPreviewPlaceholderEl.textContent = 'Loading preview…';
	symbolPreviewPlaceholderEl.classList.remove('hidden');
	symbolPreviewCanvasEl.classList.add('hidden');
	try {
		const source = await symbolLibraryCache.readCachedFile(item.file.id);
		// A newer selection (user arrowed/clicked past this one before the
		// cached-file read resolved) has already superseded this request —
		// don't let a stale, slow response clobber what's now selected.
		if (requestId !== symbolPreviewRequestId) return;

		if (!symbolPreviewSession) {
			symbolPreviewSession = new KicadRenderSession(symbolPreviewCanvasEl, null);
		}
		const dpr = window.devicePixelRatio || 1;
		// Measure the always-visible WRAPPER, not the canvas itself — the
		// canvas starts (and returns to, between previews) `display:none`
		// via .hidden, and getBoundingClientRect() on a display:none element
		// is always 0×0, which is below resize()'s own minFitViewportPx
		// floor — it silently no-ops rather than shrink the buffer to
		// something unusable, which left the canvas stuck at the browser's
		// default 300×150 HTML canvas buffer on every single preview.
		const rect = symbolPreviewArtEl.getBoundingClientRect();
		symbolPreviewSession.resize(Math.max(1, Math.floor(rect.width * dpr)), Math.max(1, Math.floor(rect.height * dpr)));

		const blank = '(kicad_sch (version 20221206) (generator eeschema) (uuid 00000000-0000-0000-0000-000000000000) (paper "A4") (lib_symbols))';
		await symbolPreviewSession.loadSchematicText(blank, { filename: 'preview.kicad_sch', showDrawingSheet: false });
		if (requestId !== symbolPreviewRequestId) return;

		const placedRef = symbolPreviewSession.addLibrarySymbolFromText(source, item.summary.name, 0, 0, item.libId);
		if (!placedRef) throw new Error('Could not render preview.');

		// schScene is a protected implementation detail — getHitElement()
		// elsewhere in this file already uses the same any-cast to reach it
		// from outside the class; this preview session is a throwaway scratch
		// instance, not the shared public API surface that protection guards.
		const previewItems = (symbolPreviewSession as any).schScene?.hitTestItems ?? [];
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const hitItem of previewItems) {
			const b = (hitItem as { bbox?: { x: number; y: number; w: number; h: number } }).bbox;
			if (!b) continue;
			minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
			maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
		}
		if (Number.isFinite(minX) && Number.isFinite(maxX)) {
			const width = Math.max(1, maxX - minX);
			const height = Math.max(1, maxY - minY);
			const padX = width * 0.15;
			const padY = height * 0.15;
			symbolPreviewSession.camera.bbox = new BBox(minX - padX, minY - padY, width + padX * 2, height + padY * 2);
		}
		symbolPreviewSession.render();
		symbolPreviewPlaceholderEl.classList.add('hidden');
		symbolPreviewCanvasEl.classList.remove('hidden');
	}
	catch (error) {
		if (requestId !== symbolPreviewRequestId) return;
		symbolPreviewPlaceholderEl.textContent = error instanceof Error ? error.message : 'Could not render preview.';
		symbolPreviewPlaceholderEl.classList.remove('hidden');
		symbolPreviewCanvasEl.classList.add('hidden');
	}
}

// ---- Symbol chooser: virtualized list ----
// A real KiCad-scale library index (its own standard libraries alone run
// 20k+ symbols) makes appending one real DOM row per match unusably slow.
// Instead: flatten the grouped/filtered data into one array of fixed-height
// "group header" | "row" entries with precomputed cumulative pixel offsets,
// then on every render only create DOM nodes for whichever slice is
// actually within (or just outside) the scroll container's viewport,
// absolutely-positioned at their real offset inside a spacer div sized to
// the FULL virtual content height — the scrollbar behaves exactly as if
// every row were really there, only a small window of it ever exists in
// the DOM at once.
const CHOOSER_ROW_HEIGHT = 30;
const CHOOSER_GROUP_HEIGHT = 24;
/** Extra items rendered just outside the visible viewport so a fast
 *  scroll/trackpad flick doesn't flash empty space before the next
 *  scroll-driven repaint catches up. */
const CHOOSER_BUFFER_ITEMS = 8;

type ChooserListItem =
	| { type: 'group'; label: string; height: number }
	| { type: 'row'; item: PendingSymbol; height: number };

let symbolChooserFlatItems: ChooserListItem[] = [];
/** offsets[i] = top pixel offset of symbolChooserFlatItems[i] within the spacer. */
let symbolChooserItemOffsets: number[] = [];
let symbolChooserListInnerEl: HTMLDivElement | null = null;
let symbolChooserWindowFramePending = false;

function buildSymbolChooserFlatItems(filtered: PendingSymbol[]): void {
	const items: ChooserListItem[] = [];
	let previousFile = '';
	for (const row of filtered) {
		if (row.file.id !== previousFile) {
			items.push({ type: 'group', label: row.file.relativePath, height: CHOOSER_GROUP_HEIGHT });
			previousFile = row.file.id;
		}
		items.push({ type: 'row', item: row, height: CHOOSER_ROW_HEIGHT });
	}
	symbolChooserFlatItems = items;
	const offsets: number[] = [];
	let cursor = 0;
	for (const entry of items) {
		offsets.push(cursor);
		cursor += entry.height;
	}
	symbolChooserItemOffsets = offsets;
}

function totalSymbolChooserHeight(): number {
	const n = symbolChooserFlatItems.length;
	if (!n) return 0;
	return symbolChooserItemOffsets[n - 1]! + symbolChooserFlatItems[n - 1]!.height;
}

/** Binary search over the precomputed offsets: first item whose bottom edge
 *  is past `y` (i.e. the first item at least partially visible at that
 *  scroll position). Offsets are monotonically increasing, so this is a
 *  correct, fast (O(log n)) alternative to the fixed-row-height division a
 *  uniform-height virtual list could use — group headers and rows differ. */
function symbolChooserIndexAtOffset(y: number): number {
	let lo = 0, hi = symbolChooserFlatItems.length - 1, result = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const bottom = symbolChooserItemOffsets[mid]! + symbolChooserFlatItems[mid]!.height;
		if (bottom > y) { result = mid; hi = mid - 1; }
		else { lo = mid + 1; }
	}
	return result;
}

/** Repaints ONLY the currently-visible slice — call on scroll, or after a
 *  selection change that needs `.selected` to move. Does NOT touch the
 *  flat item list or scroll position, unlike renderSymbolChooserList. */
function renderSymbolChooserWindow(): void {
	const inner = symbolChooserListInnerEl;
	if (!inner) return;
	inner.replaceChildren();
	if (!symbolChooserFlatItems.length) {
		const empty = document.createElement('div');
		empty.className = 'symbol-chooser-group';
		empty.textContent = symbolChooserRows.length ? 'No matching symbols' : 'Index a .kicad_sym directory first.';
		inner.appendChild(empty);
		return;
	}
	const viewportHeight = symbolChooserListEl.clientHeight || 300;
	const scrollTop = symbolChooserListEl.scrollTop;
	const startIndex = Math.max(0, symbolChooserIndexAtOffset(scrollTop) - CHOOSER_BUFFER_ITEMS);
	const endIndex = Math.min(
		symbolChooserFlatItems.length - 1,
		symbolChooserIndexAtOffset(scrollTop + viewportHeight) + CHOOSER_BUFFER_ITEMS
	);
	for (let i = startIndex; i <= endIndex; i++) {
		const entry = symbolChooserFlatItems[i]!;
		const top = symbolChooserItemOffsets[i]!;
		if (entry.type === 'group') {
			const group = document.createElement('div');
			group.className = 'symbol-chooser-group';
			group.style.cssText = `position:absolute; top:${top}px; left:0; right:0;`;
			group.textContent = entry.label;
			inner.appendChild(group);
		}
		else {
			const row = document.createElement('div');
			row.className = 'symbol-chooser-row';
			row.style.cssText = `position:absolute; top:${top}px; left:0; right:0; box-sizing:border-box;`;
			row.dataset.fileId = entry.item.file.id;
			row.dataset.symbolName = entry.item.summary.name;
			if (pendingSymbol && row.dataset.fileId === pendingSymbol.file.id && row.dataset.symbolName === pendingSymbol.summary.name) row.classList.add('selected');
			const name = document.createElement('span');
			name.textContent = entry.item.summary.name;
			const description = document.createElement('small');
			description.textContent = entry.item.summary.description || entry.item.summary.value || entry.item.summary.reference || '';
			row.append(name, description);
			inner.appendChild(row);
		}
	}
}

function scheduleSymbolChooserWindowRender(): void {
	if (symbolChooserWindowFramePending) return;
	symbolChooserWindowFramePending = true;
	requestAnimationFrame(() => {
		symbolChooserWindowFramePending = false;
		renderSymbolChooserWindow();
	});
}

/** Full rebuild: re-filters, re-flattens, resizes the spacer to the new
 *  total height, and resets scroll to top (matches the old behavior, where
 *  a fresh filter keystroke's replaceChildren() implicitly did the same). */
function renderSymbolChooserList(): void {
	const query = symbolChooserFilterEl.value.trim().toLowerCase();
	const filtered = symbolChooserRows.filter(item => {
		const haystack = `${item.summary.name} ${item.summary.value} ${item.summary.description} ${item.summary.keywords} ${item.file.relativePath}`.toLowerCase();
		return !query || haystack.includes(query);
	});
	buildSymbolChooserFlatItems(filtered);
	if (!symbolChooserListInnerEl) {
		symbolChooserListEl.replaceChildren();
		symbolChooserListInnerEl = document.createElement('div');
		symbolChooserListInnerEl.style.position = 'relative';
		symbolChooserListEl.appendChild(symbolChooserListInnerEl);
	}
	symbolChooserListInnerEl.style.height = `${totalSymbolChooserHeight()}px`;
	symbolChooserListEl.scrollTop = 0;
	renderSymbolChooserWindow();
}
symbolChooserListEl.addEventListener('scroll', scheduleSymbolChooserWindowRender);

async function openSymbolChooser(): Promise<void> {
	try {
		const files = await symbolLibraryCache.getFiles();
		symbolChooserRows = files.flatMap(file => file.symbols.map(summary => ({ file, summary, libId: symbolLibraryId(file, summary) })));
		pendingSymbol = symbolChooserRows[0] ?? null;
		symbolChooserTitleEl.textContent = `Choose Symbol (${symbolChooserRows.length} items loaded)`;
		symbolChooserFilterEl.value = '';
		// Show the modal BEFORE building the list — renderSymbolChooserList's
		// virtual-scroll math reads symbolChooserListEl.clientHeight, which is
		// 0 while the modal is still display:none, so the list built while
		// hidden sized its window for a 0-height viewport and needed a scroll
		// event (any clientHeight-dependent recompute) before anything showed.
		symbolChooserEl.classList.remove('hidden');
		renderSymbolChooserList();
		void renderSymbolChooserPreview(pendingSymbol);
		symbolChooserFilterEl.focus();
	}
	catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
	}
}

function closeSymbolChooser(): void {
	symbolChooserEl.classList.add('hidden');
	pendingSymbol = null;
}

/** Places one unit of the current library symbol at `x,y` under `reference`
 *  (a fresh reference when null). Shared by both the bulk ("Place all
 *  units", stacking every unit under one click) and sequential ("click
 *  again for the next unit") flows below. */
function placeSymbolUnit(item: PendingSymbol, source: string, x: number, y: number, unit: number, reference: string | null): string | null {
	return session!.addLibrarySymbolFromText(source, item.summary.name, x, y, item.libId, unit, reference ?? undefined);
}

/** Vertical spacing between bulk-stacked units — generous enough to clear a
 *  typical gate symbol's bounding box (a few pin-pitches tall) without
 *  measuring each unit's real extent, which would need a full throwaway
 *  render per unit just to lay out one click's worth of placement. The user
 *  can drag units apart afterward if a particular symbol needs more room. */
const BULK_UNIT_SPACING_MM = 12.7;

async function beginPendingSymbolPlacement(anchor: Vec2): Promise<void> {
	const item = pendingSymbol;
	if (!item || !session) return;
	try {
		setStatus(`Loading ${item.summary.name}…`);
		const source = await symbolLibraryCache.readCachedFile(item.file.id);

		// Continuing a sequential multi-unit placement: same libId as the
		// in-progress state means this click is "the next unit", not a fresh
		// symbol. Any mismatch (different symbol picked mid-sequence, or no
		// state at all) starts over at unit 1 with a new reference.
		const continuing = pendingUnitState?.libId === item.libId ? pendingUnitState : null;

		if (continuing) {
			const reference = placeSymbolUnit(item, source, anchor.x, anchor.y, continuing.nextUnit, continuing.reference);
			if (!reference) throw new Error(`Could not place ${item.summary.name}.`);
			lastFullSch = session.getSchematicText() || lastFullSch;
			selectedRef = reference;
			finishOrAdvanceUnit(item, reference, continuing.nextUnit, continuing.totalUnits);
			return;
		}

		const totalUnits = session.getLibrarySymbolUnitCount(source, item.summary.name);

		if (totalUnits > 1 && symbolAllUnitsEl.checked) {
			let reference: string | null = null;
			for (let unit = 1; unit <= totalUnits; unit++) {
				reference = placeSymbolUnit(item, source, anchor.x, anchor.y + BULK_UNIT_SPACING_MM * (unit - 1), unit, reference);
				if (!reference) throw new Error(`Could not place ${item.summary.name}.`);
			}
			lastFullSch = session.getSchematicText() || lastFullSch;
			selectedRef = reference;
			setStatus(`Placed ${item.summary.name} (${totalUnits} units) as ${reference}. Click to place another or Esc to stop.`);
			if (!symbolRepeatCopiesEl.checked) {
				pendingSymbol = null;
				setEditTool('select');
			}
			return;
		}

		const reference = placeSymbolUnit(item, source, anchor.x, anchor.y, 1, null);
		if (!reference) throw new Error(`Could not place ${item.summary.name}.`);
		lastFullSch = session.getSchematicText() || lastFullSch;
		selectedRef = reference;
		finishOrAdvanceUnit(item, reference, 1, totalUnits);
	}
	catch (error) {
		setStatus(error instanceof Error ? error.message : String(error));
		setEditTool('select');
		pendingUnitState = null;
	}
}

/** Shared tail for both the "just placed unit 1 of N" and "just placed unit
 *  K of N while continuing" cases: either arm pendingUnitState for the next
 *  unit, or clear it and fall through to the ordinary single-symbol
 *  completion (repeat-copies check + status message). */
function finishOrAdvanceUnit(item: PendingSymbol, reference: string, placedUnit: number, totalUnits: number): void {
	if (totalUnits > 1 && placedUnit < totalUnits) {
		pendingUnitState = { libId: item.libId, reference, nextUnit: placedUnit + 1, totalUnits };
		setStatus(`Placed ${item.summary.name} unit ${placedUnit}/${totalUnits} as ${reference}. Click to place unit ${placedUnit + 1} or Esc to stop.`);
		return;
	}
	pendingUnitState = null;
	setStatus(`Placed ${item.summary.name}${totalUnits > 1 ? ` (${totalUnits} units)` : ''} as ${reference}. Click to place another or Esc to stop.`);
	if (!symbolRepeatCopiesEl.checked) {
		pendingSymbol = null;
		setEditTool('select');
	}
}

symbolChooserFilterEl.addEventListener('input', renderSymbolChooserList);
symbolChooserListEl.addEventListener('click', event => {
	const row = (event.target as HTMLElement).closest<HTMLElement>('.symbol-chooser-row');
	if (!row?.dataset.fileId || !row.dataset.symbolName) return;
	const fileId = row.dataset.fileId;
	const symbolName = row.dataset.symbolName;
	pendingSymbol = symbolChooserRows.find(item => item.file.id === fileId && item.summary.name === symbolName) ?? null;
	// Repaint the window only (moves .selected) — NOT the full list rebuild,
	// which would reset scroll to top on every single row click.
	renderSymbolChooserWindow();
	void renderSymbolChooserPreview(pendingSymbol);
});
/** Cancel/Close/Escape all fully abandon placement (back to select) — unlike
 *  closeSymbolChooser() alone, which the OK handler below also uses but
 *  deliberately does NOT revert the tool, since OK's whole point is to
 *  proceed with placing. */
function cancelSymbolPlacement(): void {
	closeSymbolChooser();
	pendingSymbolAnchor = null;
	setEditTool('select');
}
symbolChooserCancelEl.addEventListener('click', cancelSymbolPlacement);
symbolChooserCloseEl.addEventListener('click', cancelSymbolPlacement);
symbolChooserOkEl.addEventListener('click', () => {
	if (!pendingSymbol) return;
	const item = pendingSymbol;
	closeSymbolChooser();
	pendingSymbol = item;
	if (pendingSymbolAnchor) {
		const anchor = pendingSymbolAnchor;
		pendingSymbolAnchor = null;
		void beginPendingSymbolPlacement(anchor);
	}
	else {
		// Defensive fallback only — every current entry point into the
		// chooser sets pendingSymbolAnchor via a canvas click first.
		setEditTool('place-symbol');
		setStatus(`Click to place ${item.summary.name}.`);
	}
});

function updateEditSidebar(): void {
	if (!session || mode !== 'edit') return;
	// session.selection degrades to null for BOTH "0 selected" and "2+
	// selected" (see its own doc comment) — handle the multi-item case
	// first so it doesn't fall into the "No objects selected" branch below,
	// which would be actively misleading for a real multi-selection.
	if (session.selectionIds.size > 1) {
		const items = (session.activeScene?.hitTestItems ?? []).filter(item => session!.selectionIds.has(item.id));
		const names = new Set(items.map(item => (item as any).element?.name));
		const [onlyName] = names;
		if (items.length > 0 && names.size === 1 && onlyName && MULTI_EDIT_NAMES.has(onlyName)) {
			renderMultiProperties(onlyName, items.map(item => (item as any).element), items.map(item => item.id));
		}
		else {
			editPropertiesEl.textContent = `${session.selectionIds.size} objects selected`;
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
					renderSymbolProperties(element, hit.kind, hit.id);
					break;
				case 'symbol-graphic':
					renderShapeProperties(element, hit.kind, hit.id);
					break;
				case 'wire':
				case 'bus':
					renderWireBusProperties(element, hit.kind, hit.id);
					break;
				case 'junction':
					renderJunctionProperties(element, hit.id);
					break;
				case 'text':
					// kind:'text' also covers table cells (KicadElementTableCell),
					// which have a wholly different property surface (row/col
					// span, per-cell margins, …) real KiCad exposes through its
					// own separate DIALOG_TABLECELL_PROPERTIES — out of scope
					// here, so they fall through to the generic display below
					// rather than getting a mismatched text/font panel.
					if (element.name === 'text' || element.name === 'text_box') {
						renderTextProperties(element, hit.id);
					}
					else {
						editPropertiesEl.textContent = `${hit.kind}\nID: ${hit.id}`;
					}
					break;
				case 'label':
					renderLabelProperties(element, labelKind, hit.id);
					break;
				default:
					editPropertiesEl.textContent = `${hit.kind}\nID: ${hit.id}`;
			}
		}
	}
	const sheets = session.currentSheets;
	editHierarchyEl.innerHTML = sheets.length
		? sheets.map(sheet => `<div class="hierarchy-row">● ${sheet.name} (${sheet.file})</div>`).join('')
		: '<div class="hierarchy-row">● Root schematic</div>';
	updateUndoStackPane();
}

function updateUndoStackPane(): void {
	if (!session) return;
	const history = session.getUndoStackDebug();
	editUndoStackEl.innerHTML = history.undo.length || history.redoDepth
		? `<div class="history-summary">Undo: ${history.undoDepth} · Redo: ${history.redoDepth}</div>`
			+ history.undo.slice().reverse().map((entry, index) => `<div class="history-row"><span>${index === 0 ? '↶' : '·'}</span> ${entry.label}<small>${entry.bytes} B</small></div>`).join('')
			+ (history.redoDepth ? `<div class="history-redo">Redo entries: ${history.redoDepth}</div>` : '')
		: '<div class="history-empty">No undo snapshots</div>';
}

for (const splitter of Array.from(document.querySelectorAll<HTMLElement>('.pane-splitter'))) {
	 splitter.addEventListener('pointerdown', (event) => {
		 event.preventDefault();
		 const before = splitter.previousElementSibling as HTMLElement | null;
		 const parent = splitter.parentElement;
		 if (!before || !parent) return;
		 const startY = event.clientY;
		 const startHeight = before.getBoundingClientRect().height;
		 const move = (moveEvent: PointerEvent) => {
			 const next = Math.max(60, Math.min(parent.clientHeight - 120, startHeight + moveEvent.clientY - startY));
			 before.style.flex = 'none';
			 before.style.height = `${next}px`;
		 };
		 const done = () => {
			 window.removeEventListener('pointermove', move);
			 window.removeEventListener('pointerup', done);
		 };
		 window.addEventListener('pointermove', move);
		 window.addEventListener('pointerup', done, { once: true });
	});
}

function setScore(text: string): void {
	scoreEl.textContent = text;
}

function updateLockedNets(): void {
	if (!lockedNetlist) {
		lockedNetsEl.textContent = 'No schematic netlist locked.';
		return;
	}
	const rows = Object.entries(lockedNetlist.pinNetsByRef)
		.flatMap(([ref, pins]) => Object.entries(pins).map(([pin, net]) => `${ref}.${pin}  →  ${net}`))
		.sort((a, b) => a.localeCompare(b));
	lockedNetsEl.textContent = `${lockedNetlist.summary.netCount} nets · ${rows.length} locked pins\n\n${rows.join('\n')}`;
}

function snap(n: number): number {
	return Math.round(n / PLACE_GRID) * PLACE_GRID;
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
	if (e.shiftKey && e.ctrlKey) return 'subtract';
	if (e.shiftKey || e.ctrlKey) return 'add';
	return 'replace';
}

let statusBarFramePending = false;
let pendingStatusScreenPos: Vec2 | undefined;
let lastStatusCoord = '';
let lastStatusZoom = '';

/** #grid-select IS the grid display now (its selected option shows the
 *  current value) — no separate text label to keep in sync, unlike the
 *  coord/zoom fields below which have no interactive counterpart. */
function setGridSpacing(mm: number): void {
	PLACE_GRID = mm;
	session?.setGridSpacing(mm);
}
gridSelectEl.addEventListener('change', () => {
	const mm = Number(gridSelectEl.value);
	if (Number.isFinite(mm) && mm > 0) {
		setGridSpacing(mm);
	}
});

function updateStatusBar(screenPos?: Vec2): void {
	pendingStatusScreenPos = screenPos ?? pendingStatusScreenPos;
	if (statusBarFramePending) return;
	statusBarFramePending = true;
	requestAnimationFrame(() => {
		statusBarFramePending = false;
		const s = session;
		const world = s && pendingStatusScreenPos ? s.screenToWorld(pendingStatusScreenPos) : null;
		const coord = world ? `X: ${world.x.toFixed(2)}  Y: ${world.y.toFixed(2)}` : lastStatusCoord;
		const zoom = `Zoom: ${s && Number.isFinite(s.camera.zoom) ? `${s.camera.zoom.toFixed(2)}×` : '—'}`;
		if (coord !== lastStatusCoord) { coordStatusEl.textContent = coord; lastStatusCoord = coord; }
		if (zoom !== lastStatusZoom) { zoomStatusEl.textContent = zoom; lastStatusZoom = zoom; }
	});
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
		new Vec2(box.x, y2), new Vec2(cx, y2), new Vec2(x2, y2),
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

function resizedBoundsFromHandle(box: SelectionResizeBox, handle: Exclude<ResizeHandle, 'center'>, cursor: Vec2): SelectionResizeBox {
	let left = box.x;
	let right = box.x + box.width;
	let top = box.y;
	let bottom = box.y + box.height;
	if (handle.includes('w')) left = Math.min(cursor.x, right - PLACE_GRID);
	if (handle.includes('e')) right = Math.max(cursor.x, left + PLACE_GRID);
	if (handle.includes('n')) top = Math.min(cursor.y, bottom - PLACE_GRID);
	if (handle.includes('s')) bottom = Math.max(cursor.y, top + PLACE_GRID);
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
	return !!recipe && !!icSymbolText.trim() && placements.length > 0;
}

function canLockedAutoroute(): boolean {
	return !!lockedNetlist && placements.length > 0;
}

function canAutoroute(): boolean {
	return canRecipeAutoroute() || canLockedAutoroute();
}

function lockNetlistFromText(text: string, force = false): void {
	if (lockedNetlist && !force) {
		dbg('lockNetlist skipped — already locked');
		return;
	}
	try {
		lockedNetlist = lockNetlistFromSchematic(text);
		const nets = lockedNetlist.summary.netCount;
		const pinned = Object.values(lockedNetlist.pinNetsByRef)
			.filter(p => Object.keys(p).length > 0).length;
		dbg('lockNetlist', {
			nets,
			pinned,
			warnings: lockedNetlist.warnings,
		});
		if (lockedNetlist.warnings.length) {
			setScore(lockedNetlist.warnings.join('\n'));
		}
		updateLockedNets();
	}
	catch (err) {
		lockedNetlist = null;
		updateLockedNets();
		dbg('lockNetlist failed', err);
		setScore(err instanceof Error ? err.message : String(err));
	}
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
		pinNets: { ...pinNets },
	};
}

function ensureSession(): KicadRenderSession {
	if (!session) {
		session = new KicadRenderSession(canvas, null);
		session.onError = (err) => setStatus(err instanceof Error ? err.message : String(err));
		// Matches FINE_GRID_MM's default exactly, but stay explicit rather
		// than relying on that coincidence — the user may have already
		// changed #grid-select before any session existed (e.g. before
		// opening a file).
		session.setGridSpacing(PLACE_GRID);
	}
	return session;
}

function resizeCanvas(): void {
	const dpr = window.devicePixelRatio || 1;
	const w = Math.max(1, Math.floor(stage.clientWidth * dpr));
	const h = Math.max(1, Math.floor(stage.clientHeight * dpr));
	ensureSession().resize(w, h);
}

function updateCircuitHint(): void {
	if (mode === 'edit') {
		const shapeHint = (editTool === 'global-label' || editTool === 'hier-label')
			? ` · shape: ${currentLabelShape} (Tab to cycle)`
			: editTool === 'directive-label'
				? ` · shape: ${currentDirectiveLabelShape} (Tab to cycle)`
				: '';
		const groupHint = findToolGroup(editTool) ? ' · right-click button to cycle label kind' : '';
		const powerHint = editTool === 'power'
			? ` · ${POWER_KIND_LABELS[currentPowerKind]} (right-click button to cycle)`
			: '';
		hintEl.textContent = `Tool: ${editTool}${shapeHint}${groupHint}${powerHint} · S/W/J/X/L/C/A/G/H switch tools · `
			+ 'click to draw, wire chains until same-point/dblclick · '
			+ 'select: drag to move, Delete to remove, R rotate a symbol, T tidy labels · Esc cancel';
		return;
	}
	if (mode !== 'circuit') {
		hintEl.textContent = 'Wheel zoom · drag pan · open a local KiCad file';
		return;
	}
	const n = placements.length;
	if (!n) {
		hintEl.textContent = 'Edit on · open a .kicad_sch (netlist locks on load for auto-rewire)';
		return;
	}
	if (canLockedAutoroute()) {
		hintEl.textContent = `Edit on · ${n} parts · drag / R rotate / T tidy labels · netlist locked · full rewire on drop`;
		return;
	}
	if (canRecipeAutoroute()) {
		hintEl.textContent = `Edit on · ${n} parts · drag / R · recipe rewire on drop`;
		return;
	}
	hintEl.textContent = `Edit on · ${n} parts · drag / R (open a wired schematic to lock nets)`;
}

/**
 * Build edit placements from the parsed AST in the render session — not from
 * brittle regex on raw text. Recipe is NOT required for drag/rotate.
 */
function syncPlacementsFromSession(): number {
	const s = session;
	if (!s) {
		placements = [];
		return 0;
	}
	const poses = s.listSymbolPoses();
	placements = poses.map(poseToPlacement);
	if (lockedNetlist) {
		placements = applyLockedPinNets(placements, lockedNetlist);
	}
	dbg('syncPlacementsFromSession', {
		count: placements.length,
		refs: placements.map(p => p.ref),
		locked: !!lockedNetlist,
		withPinNets: placements.filter(p => Object.keys(p.pinNets ?? {}).length > 0).length,
	});
	updateCircuitHint();
	return placements.length;
}

/** Ensure we have a placement row for this ref (create from AST if needed). */
function ensurePlacement(ref: string): CircuitPlacement | null {
	let placement = placements.find(p => p.ref === ref);
	if (placement) {
		return placement;
	}
	const pose = session?.getSymbolPose(ref) ?? null;
	dbg('ensurePlacement miss → AST lookup', { ref, pose });
	if (!pose) {
		return null;
	}
	placement = poseToPlacement(pose);
	if (lockedNetlist) {
		placement = applyLockedPinNets([placement], lockedNetlist)[0]!;
	}
	placements.push(placement);
	updateCircuitHint();
	return placement;
}

/**
 * Re-lock the netlist from the LIVE session text (not the possibly-stale
 * lastFullSch shadow copy) — picks up any hand-drawn wires edit mode left
 * behind instead of silently discarding them on the next rewire. Called on
 * every entry to circuit mode, and again after undo/redo while already
 * there (those can restore text without a mode-switch event).
 */
function relockNetlistFromLiveText(): void {
	if (session?.documentTypeLoaded !== 'schematic') {
		return;
	}
	const liveText = session.getSchematicText() || lastFullSch;
	if (!liveText) {
		return;
	}
	lockNetlistFromText(liveText, true);
	lastFullSch = liveText;
}

function setMode(next: AppMode): void {
	mode = next;
	circuitDragMode = next === 'circuit';
	modeViewBtn.classList.toggle('active', next === 'view');
	modeCircuitBtn.classList.toggle('active', next === 'circuit');
	modeEditBtn.classList.toggle('active', next === 'edit');
	viewActions.classList.toggle('hidden', next !== 'view');
	circuitActions.classList.toggle('hidden', next !== 'circuit');
	editActions.classList.toggle('hidden', next !== 'edit');
	editLeftPane.classList.toggle('hidden', next !== 'edit');
	toolPanel.classList.toggle('hidden', next !== 'edit');
	mainEl.classList.toggle('edit-mode', next === 'edit');
	if (next !== 'edit') {
		closeSymbolChooser();
		resetEditToolState();
	}

	if (next === 'view') {
		setStatus('Open a .kicad_sch or .kicad_pcb file.');
	}
	else if (next === 'circuit' && session?.documentTypeLoaded === 'schematic') {
		relockNetlistFromLiveText();
		const n = syncPlacementsFromSession();
		setStatus(n
			? (canLockedAutoroute()
				? `Edit mode on — ${n} parts, netlist locked. Drag to auto-rewire.`
				: `Edit mode on — ${n} parts from schematic.`)
			: 'Schematic loaded but no symbol instances found.');
	}
	else if (next === 'edit') {
		setStatus(session?.documentTypeLoaded === 'schematic'
			? 'Edit mode on — select tool active. Click a tool below to draw.'
			: 'Open a .kicad_sch to start hand-drawing wires/junctions/graphics.');
	}
	else {
		setStatus('Open a .kicad_sch here (or Load demo → Place). Drag needs no recipe.');
	}
	updateCircuitHint();
	updateEditSidebar();
}

async function loadTextIntoSession(text: string, kind: 'schematic' | 'board', filename: string): Promise<void> {
	const s = ensureSession();
	resizeCanvas();
	// A genuinely NEW document — undo must not step back into whatever was
	// open before. (undo()/redo() themselves call the session's own
	// loadSchematicText directly, bypassing this wrapper, so they never hit this.)
	s.resetUndoHistory();
	lastPointerWorld = null;
	if (kind === 'board') {
		await s.loadBoardText(text);
		placements = [];
		lockedNetlist = null;
		if (mode === 'circuit') {
			setStatus('Boards are view-only — open a schematic to edit placements.');
		}
	}
	else {
		lastFullSch = text;
		placedFragment = text;
		lockNetlistFromText(text, true);
		await s.loadSchematicText(text, {
			filename,
			sheetPath: '/',
			showDrawingSheet: mode === 'view',
		});
		if (mode === 'circuit' || circuitDragMode) {
			const n = syncPlacementsFromSession();
			const nets = lockedNetlist?.summary.netCount ?? 0;
			setStatus(n
				? (canLockedAutoroute()
					? `Edit on — ${n} parts, ${nets} nets locked. Drag / R to auto-rewire.`
					: `Edit on — ${n} parts (could not lock nets for rewire).`)
				: 'Schematic loaded but no symbol instances found to edit.');
		}
	}
	updateCircuitHint();
	updateEditSidebar();
}

async function openKiCadFile(file: File): Promise<void> {
	const text = await file.text();
	const name = file.name.toLowerCase();
	dbg('openKiCadFile', { name, mode, bytes: text.length });
	if (name.endsWith('.kicad_pcb')) {
		await loadTextIntoSession(text, 'board', file.name);
		if (mode === 'view') {
			setStatus(`Loaded board ${file.name}`);
		}
	}
	else if (mode === 'view') {
		await loadTextIntoSession(text, 'schematic', file.name);
		setStatus(`Loaded schematic ${file.name}. Switch to Circuit layout to drag/rotate.`);
	}
	else {
		await loadTextIntoSession(text, 'schematic', file.name);
	}
}

async function loadDemo(): Promise<void> {
	const [recipeRes, symRes] = await Promise.all([
		fetch('/demo/recipe.json'),
		fetch('/demo/demo-ic.kicad_sym'),
	]);
	if (!recipeRes.ok || !symRes.ok) {
		throw new Error('Demo assets missing under public/demo.');
	}
	recipe = await recipeRes.json() as CircuitDesignRecipe;
	icSymbolText = await symRes.text();
	setStatus('Demo recipe + symbol loaded. Click Place.');
	setScore('');
	updateCircuitHint();
}

function runPlace(): void {
	if (!recipe || !icSymbolText.trim()) {
		setStatus('Need recipe + IC symbol first (Load demo or pick files).');
		return;
	}
	try {
		// Recipe Place owns rewire via emitFragment — clear any file-locked netlist.
		lockedNetlist = null;
		updateLockedNets();
		const result = placeFromInputs({
			recipe,
			icSymbolText,
			icMpnFallback: recipe.ic.mpn,
		});
		placements = result.placements;
		placedFragment = result.kicadSchFragment;
		lastFullSch = wrapFullSchematic(result.kicadSchFragment);
		circuitDragMode = true;
		void loadTextIntoSession(lastFullSch, 'schematic', 'circuit-place.kicad_sch').then(() => {
			// loadTextIntoSession re-locks from text; drop that so recipe reroute stays active.
			lockedNetlist = null;
			placements = result.placements;
			setStatus(`Edit mode on — placed ${placements.length} parts. Drag or Auto wire.`);
			setScore(result.warnings.join('\n'));
			updateCircuitHint();
		});
	}
	catch (err) {
		setStatus(err instanceof Error ? err.message : String(err));
	}
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
	if (!canAutoroute() || rerouting) {
		if (!canAutoroute() && mode === 'circuit') {
			dbg('skip reroute — no locked netlist and no recipe');
			setStatus('Moved. Open a wired schematic to lock nets, or Load demo → Place.');
		}
		return;
	}
	rerouting = true;
	setStatus(connectivity === 'clear-wires' ? 'Clearing wires…' : 'Rewiring…');
	try {
		// Prefer locked netlist when present (opened schematic). Recipe Place clears the lock.
		const useLocked = canLockedAutoroute();
		if (useLocked) {
			const schText = ensureSession().getSchematicText() || lastFullSch;
			const result = rewireSchematic({
				schematicText: schText,
				placements,
				locked: lockedNetlist ?? undefined,
				connectivity,
			});
			// Keep the session lock frozen — the pin↔net map is the source of truth.
			placements = result.placements;
			lastFullSch = result.kicadSchFull;
			placedFragment = result.kicadSchFull;
			await ensureSession().loadSchematicText(result.kicadSchFull, {
				filename: 'circuit-rewire.kicad_sch',
				sheetPath: '/',
				showDrawingSheet: false,
				preserveView: true,
			});
			syncPlacementsFromSession();
			restoreSelection();
			reportRewire(result.invalidNets, result.score.breakdown, result.warnings, connectivity);
			dbg('rewire', {
				invalidNets: result.invalidNets,
				segments: result.segments.length,
				warnings: result.warnings,
			});
		}
		else {
			const result = reroute({
				recipe: recipe!,
				icSymbolText,
				placements,
				icMpnFallback: recipe!.ic.mpn,
				connectivity,
			});
			placements = result.placements;
			placedFragment = result.kicadSchFragment;
			lastFullSch = result.kicadSchFull;
			await ensureSession().loadSchematicText(result.kicadSchFull, {
				filename: 'circuit-reroute.kicad_sch',
				sheetPath: '/',
				showDrawingSheet: false,
				preserveView: true,
			});
			restoreSelection();
			setStatus(connectivity === 'clear-wires' ? 'Wires cleared.' : 'Rewired (recipe).');
			setScore(result.score.breakdown + (result.warnings.length ? `\n${result.warnings.join('\n')}` : ''));
		}
		updateCircuitHint();
	}
	catch (err) {
		setStatus(err instanceof Error ? err.message : String(err));
	}
	finally {
		rerouting = false;
	}
}

function restoreSelection(): void {
	if (!selectedRef || !session) {
		return;
	}
	const items = session.activeScene?.hitTestItems ?? [];
	// Prefer the exact paint id in edit mode (always set alongside
	// selectedRef there) — several instances can share one Reference for a
	// multi-unit part, so matching by refDesignator alone would silently
	// restore selection to a DIFFERENT unit than the one actually selected.
	// Circuit mode never sets editSelectedId, so it always takes the
	// refDesignator path below, unchanged (its placements are reference-
	// unique on their own — no multi-unit concept there).
	const hit = (mode === 'edit' && editSelectedId)
		? items.find(item => item.id === editSelectedId)
		: items.find(item =>
			(item as { kind?: string; refDesignator?: string }).kind === 'symbol'
			&& (item as { refDesignator?: string }).refDesignator === selectedRef
		);
	session.select(hit?.id ?? null);
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
			listSample: session.listSymbolPoses().slice(0, 20),
		});
		setStatus(`Selected ${ref}, but AST has no pose for it — check console.`);
		return;
	}
	dbg('beginSymbolDrag', placement);
	session.pushUndoSnapshot('Symbol drag');
	const world = session.screenToWorld(screenPos);
	dragRef = ref;
	dragMoved = false;
	dragStartPose = { x: placement.x, y: placement.y, rotation: placement.rotation };
	dragOffset = new Vec2(world.x - placement.x, world.y - placement.y);
}

/** Edit mode's select-tool symbol drag start — sources the pose directly
 *  from the live AST, unlike circuit mode's placements-array-backed variant
 *  (edit mode never touches placements/pinNets — it's not net-aware).
 *  `instanceId` (the hit paint id) disambiguates which unit of a multi-unit
 *  part to move — see dragInstanceId's own doc comment. */
function beginEditSymbolDrag(ref: string, instanceId: string, screenPos: Vec2): void {
	if (!session) {
		return;
	}
	const pose = session.getSymbolPose(ref, instanceId);
	if (!pose) {
		return;
	}
	const world = session.screenToWorld(screenPos);
	dragRef = ref;
	dragInstanceId = instanceId;
	dragMoved = false;
	dragStartPose = { x: pose.x, y: pose.y, rotation: pose.rotation };
	dragOffset = new Vec2(world.x - pose.x, world.y - pose.y);
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
	dragSheetId = paintId;
	dragMoved = false;
	dragStartPose = { x: pos.x, y: pos.y, rotation: 0 };
	dragOffset = new Vec2(world.x - pos.x, world.y - pos.y);
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
	dragSheetPinId = paintId;
	dragMoved = false;
	dragStartPose = { x: pos.x, y: pos.y, rotation: pos.rotation ?? 0 };
	dragOffset = new Vec2(world.x - pos.x, world.y - pos.y);
}

async function rotateSelected(): Promise<void> {
	if (!selectedRef || !session || rerouting) {
		return;
	}
	if (mode === 'edit') {
		const instanceId = editSelectedId ?? undefined;
		const pose = session.getSymbolPose(selectedRef, instanceId);
		if (!pose) {
			setStatus('Nothing selected to rotate — click a symbol first.');
			return;
		}
		session.pushUndoSnapshot();
		const newRotation = (pose.rotation + 90) % 360;
		session.moveSymbolByRef(selectedRef, pose.x, pose.y, newRotation, instanceId);
		lastFullSch = session.getSchematicText() || lastFullSch;
		setStatus(`Rotated ${selectedRef} to ${newRotation}°.`);
		return;
	}
	if (!circuitDragMode) {
		return;
	}
	const placement = ensurePlacement(selectedRef);
	if (!placement) {
		setStatus('Nothing selected to rotate — click a symbol first.');
		return;
	}
	if (isEditablePowerPlacement(placement)) {
		setStatus('GND orientation is locked');
		return;
	}
	session.pushUndoSnapshot();
	placement.rotation = (placement.rotation + 90) % 360;
	session.moveSymbolByRef(placement.ref, placement.x, placement.y, placement.rotation);
	if (canAutoroute()) {
		await commitReroute('autoroute');
	}
	else {
		setStatus(`Rotated ${placement.ref} to ${placement.rotation}°.`);
	}
}

function downloadSchematic(): void {
	const text = lastFullSch.trim() || (placedFragment.trim() ? wrapFullSchematic(placedFragment) : '');
	if (!text) {
		setStatus('Nothing to export — Place or open a schematic first.');
		return;
	}
	const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${recipe?.ic.mpn || 'circuit'}.kicad_sch`;
	a.click();
	URL.revokeObjectURL(url);
	setStatus('Downloaded schematic.');
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
	lastFullSch = session.getSchematicText() || lastFullSch;
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

modeViewBtn.addEventListener('click', () => setMode('view'));
modeCircuitBtn.addEventListener('click', () => setMode('circuit'));
modeEditBtn.addEventListener('click', () => setMode('edit'));

for (const btn of editToolButtons) {
	btn.addEventListener('click', () => {
		const tool = btn.dataset.tool as EditTool | undefined;
		if (tool) {
			if (tool === 'image') {
				startImageInsertion();
			}
			else if (tool === 'place-symbol') {
				// Arm only — the chooser opens on the first canvas click (see
				// handleEditModeMouseDown's place-symbol branch), not here, so
				// the user can see where the symbol will land before picking one.
				setEditTool('place-symbol');
				setStatus('Click on canvas to choose where to place a symbol.');
			}
			else {
				setEditTool(tool);
			}
		}
	});
}

const powerToolButton = document.getElementById('btn-power-tool') as HTMLButtonElement;

function updatePowerToolButton(): void {
	const svg = powerToolButton.querySelector('svg.tool-icon');
	if (svg) {
		svg.innerHTML = POWER_KIND_ICONS[currentPowerKind];
	}
	powerToolButton.title = `Power symbol: ${POWER_KIND_LABELS[currentPowerKind]} — right-click to cycle GND/PWR_FLAG/rail`;
}

function cyclePowerKind(): void {
	const idx = POWER_KIND_CYCLE.indexOf(currentPowerKind);
	currentPowerKind = POWER_KIND_CYCLE[(idx + 1) % POWER_KIND_CYCLE.length]!;
	updatePowerToolButton();
	if (editTool === 'power') {
		// Live-refresh whatever preview/input state the previous variant left
		// behind — e.g. switching away from 'rail' while text input is open.
		resetEditToolState();
		updateCircuitHint();
	}
}

powerToolButton.addEventListener('contextmenu', (e) => {
	e.preventDefault();
	cyclePowerKind();
});

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
	button.addEventListener('contextmenu', (e) => {
		e.preventDefault();
		cycleGroup(group);
	});
}

document.getElementById('file-input')!.addEventListener('change', (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (file) void openKiCadFile(file);
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
	if (!file) return;
	recipe = JSON.parse(await file.text()) as CircuitDesignRecipe;
	setStatus(`Recipe loaded (${file.name}).`);
	updateCircuitHint();
});

document.getElementById('symbol-input')!.addEventListener('change', async (e) => {
	const file = (e.target as HTMLInputElement).files?.[0];
	if (!file) return;
	icSymbolText = await file.text();
	setStatus(`Symbol loaded (${file.name}).`);
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
		setStatus(`Image loaded (${file.name}) — click the schematic to place it.`);
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
	// openSymbolChooser() auto-selects the first row into pendingSymbol as
	// soon as it resolves — silently place whatever that first row happened
	// to be, ignoring the modal entirely. The window 'click' listener still
	// runs afterward for the ones that use click-outside-to-close.
	if (!contextMenuEl.classList.contains('hidden') || !propertiesModalEl.classList.contains('hidden') || !symbolChooserEl.classList.contains('hidden')) {
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
			dragLabelId = labelHit.id;
			dragMoved = false;
			dragStartPose = { x: origin.x, y: origin.y, rotation: origin.rotation ?? 0 };
			dragOffset = new Vec2(world.x - origin.x, world.y - origin.y);
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
	if (!s) return;
	const pos = screenPosFromEvent(e);
	lastPointerWorld = s.screenToWorld(pos);
	updateStatusBar(pos);

	if (mode === 'edit' && editTool !== 'select') {
		const worldPos = s.screenToWorld(pos);
		updateEditPreview(s, new Vec2(snap(worldPos.x), snap(worldPos.y)));
		return;
	}
	if (mode === 'edit' && curveDrag) {
		const worldPos = s.screenToWorld(pos);
		if (s.moveCurveAnchorById(curveDrag.id, curveDrag.anchor, snap(worldPos.x), snap(worldPos.y))) {
			dragMoved = true;
		}
		return;
	}
	if (mode === 'edit' && resizeDrag) {
		const worldPos = s.screenToWorld(pos);
		const bounds = resizedBoundsFromHandle(
			resizeDrag.original, resizeDrag.handle, new Vec2(snap(worldPos.x), snap(worldPos.y))
		);
		if (s.resizeElementBoundsById(resizeDrag.id, bounds.x, bounds.y, bounds.width, bounds.height, resizeDrag.handle)) {
			dragMoved = true;
		}
		return;
	}
	if (mode === 'edit' && editDragId) {
		const worldPos = s.screenToWorld(pos);
		const snapped = new Vec2(snap(worldPos.x), snap(worldPos.y));
		if (editDragLastPos) {
			const dx = snapped.x - editDragLastPos.x;
			const dy = snapped.y - editDragLastPos.y;
			if (dx !== 0 || dy !== 0) {
				s.translateElementById(editDragId, dx, dy);
				editDragLastPos = snapped;
				dragMoved = true;
			}
		}
		return;
	}
	if (mode === 'edit' && rectSelectDrag) {
		const worldPos = s.screenToWorld(pos);
		if (!dragMoved && Math.hypot(pos.x - rectSelectDrag.originScreen.x, pos.y - rectSelectDrag.originScreen.y) > RECT_SELECT_MOVE_THRESHOLD_PX) {
			dragMoved = true;
		}
		const boxMode: 'contained' | 'touching' = worldPos.x >= rectSelectDrag.originWorld.x ? 'contained' : 'touching';
		s.setEditPreview({
			kind: 'selection-box', origin: rectSelectDrag.originWorld, cursor: worldPos,
			mode: boxMode, selectMode: rectSelectionModeFromModifiers(e),
		});
		return;
	}
	if (mode === 'edit' && groupDrag) {
		const worldPos = s.screenToWorld(pos);
		const snapped = new Vec2(snap(worldPos.x), snap(worldPos.y));
		const dx = snapped.x - groupDrag.lastSnapped.x;
		const dy = snapped.y - groupDrag.lastSnapped.y;
		if (dx !== 0 || dy !== 0) {
			if (!dragUndoCaptured) {
				s.pushUndoSnapshot('Group drag');
				dragUndoCaptured = true;
			}
			s.translateSelection([...s.selectionIds], dx, dy);
			groupDrag.lastSnapped = snapped;
			dragMoved = true;
		}
		return;
	}
	if (dragLabelId) {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - dragOffset.x);
		const ny = snap(worldPos.y - dragOffset.y);
		if (dragStartPose && (nx !== dragStartPose.x || ny !== dragStartPose.y)) {
			dragMoved = true;
		}
		s.moveLabelById(dragLabelId, nx, ny, dragStartPose?.rotation ?? 0);
		return;
	}
	if (dragSheetId) {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - dragOffset.x);
		const ny = snap(worldPos.y - dragOffset.y);
		if (dragStartPose && (nx !== dragStartPose.x || ny !== dragStartPose.y)) {
			dragMoved = true;
		}
		if (dragMoved && !dragUndoCaptured) {
			s.pushUndoSnapshot('Sheet drag');
			dragUndoCaptured = true;
		}
		s.moveSheetById(dragSheetId, nx, ny);
		return;
	}
	if (dragSheetPinId) {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - dragOffset.x);
		const ny = snap(worldPos.y - dragOffset.y);
		if (dragStartPose && (nx !== dragStartPose.x || ny !== dragStartPose.y)) {
			dragMoved = true;
		}
		if (dragMoved && !dragUndoCaptured) {
			s.pushUndoSnapshot('Sheet pin drag');
			dragUndoCaptured = true;
		}
		s.moveSheetPinById(dragSheetPinId, nx, ny);
		return;
	}
	if (dragRef) {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - dragOffset.x);
		const ny = snap(worldPos.y - dragOffset.y);
		if (mode === 'edit') {
			// Manual move — no placements bookkeeping, no rewire on drop.
			if (dragStartPose && (nx !== dragStartPose.x || ny !== dragStartPose.y)) {
				dragMoved = true;
			}
			if (dragMoved && !dragUndoCaptured) {
				s.pushUndoSnapshot('Symbol drag');
				dragUndoCaptured = true;
			}
			s.moveSymbolByRef(dragRef, nx, ny, dragStartPose?.rotation ?? 0, dragInstanceId ?? undefined);
			return;
		}
		const placement = placements.find(p => p.ref === dragRef);
		if (!placement) return;
		placement.x = nx;
		placement.y = ny;
		if (isEditablePowerPlacement(placement)) {
			placement.rotation = 0;
		}
		if (dragStartPose && (nx !== dragStartPose.x || ny !== dragStartPose.y)) {
			dragMoved = true;
		}
		s.moveSymbolByRef(placement.ref, placement.x, placement.y, placement.rotation);
		return;
	}
	if (!draggingPan) return;
	s.pan(pos.x - dragStart.x, pos.y - dragStart.y);
	dragStart = pos;
}

function onPointerUp(e: MouseEvent): void {
	const finishingSym = dragRef;
	const finishingLabel = dragLabelId;
	const finishingEditDrag = editDragId;
	const finishingResize = resizeDrag;
	const finishingCurve = curveDrag;
	const finishingSheet = dragSheetId;
	const finishingSheetPin = dragSheetPinId;
	const finishingRectSelect = rectSelectDrag;
	const finishingGroupDrag = groupDrag;
	const moved = dragMoved;
	dragRef = null;
	dragInstanceId = null;
	dragLabelId = null;
	editDragId = null;
	editDragLastPos = null;
	resizeDrag = null;
	curveDrag = null;
	dragSheetId = null;
	dragSheetPinId = null;
	rectSelectDrag = null;
	groupDrag = null;
	draggingPan = false;
	// Any symbol OR global/hier label move → full net-locked rewire (the single
	// edit path; the moved label/rail is preserved and wires re-route to it).
	if (mode === 'circuit' && circuitDragMode && (finishingSym || finishingLabel) && moved) {
		void commitReroute('autoroute');
	}
	else if (mode === 'edit' && (finishingSym || finishingEditDrag || finishingResize || finishingCurve || finishingSheet || finishingSheetPin || finishingGroupDrag) && moved && session) {
		// Manual move, no rewire — just persist the mutated AST text. Covers
		// group-drag too: translateSelection already applied every step's
		// delta live during the drag, same as every other kind here — this
		// branch only needs to persist the final text once.
		lastFullSch = session.getSchematicText() || lastFullSch;
	}
	else if (mode === 'edit' && finishingRectSelect && session) {
		const s = session;
		if (moved) {
			const worldPos = s.screenToWorld(screenPosFromEvent(e));
			const boxMode: 'contained' | 'touching' = worldPos.x >= finishingRectSelect.originWorld.x ? 'contained' : 'touching';
			const hitIds = s.hitTestRect(finishingRectSelect.originWorld, worldPos, boxMode);
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
		lastFullSch = s.getSchematicText() || lastFullSch;
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
	const s = session;
	if (!s?.canUndo) {
		setStatus('Nothing to undo.');
		return;
	}
	const restored = await s.undo();
	if (!restored) {
		setStatus('Nothing to undo.');
		return;
	}
	// Undo reloads the session's AST. Keep the app-level serialized copy in
	// lock-step; otherwise the next edit/export can reintroduce the move that
	// undo just restored.
	lastFullSch = s.getSchematicText() || lastFullSch;
	syncPlacementsFromSession();
	if (mode === 'circuit') {
		relockNetlistFromLiveText();
	}
	restoreSelection();
	setStatus('Undo.');
	updateCircuitHint();
	updateEditSidebar();
}

async function performRedo(): Promise<void> {
	const s = session;
	if (!s?.canRedo) {
		setStatus('Nothing to redo.');
		return;
	}
	const restored = await s.redo();
	if (!restored) {
		setStatus('Nothing to redo.');
		return;
	}
	lastFullSch = s.getSchematicText() || lastFullSch;
	syncPlacementsFromSession();
	if (mode === 'circuit') {
		relockNetlistFromLiveText();
	}
	restoreSelection();
	setStatus('Redo.');
	updateCircuitHint();
	updateEditSidebar();
}

window.addEventListener('keydown', (e) => {
	const t = e.target as HTMLElement | null;
	if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;

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
		if (editTool === 'select' && session && (e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey) && session.selectionIds.size > 0) {
			e.preventDefault();
			const count = copySelectionToClipboard(session, copyableIds(session, [...session.selectionIds]));
			setStatus(`Copied ${count} item(s).`);
			return;
		}
		if (editTool === 'select' && session && (e.key === 'x' || e.key === 'X') && (e.ctrlKey || e.metaKey) && session.selectionIds.size > 0) {
			e.preventDefault();
			cutSelectionToClipboard(session);
			return;
		}
		if (editTool === 'select' && session && (e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void pasteAtWorld(session, lastPointerWorld ?? new Vec2(session.camera.center.x, session.camera.center.y));
			return;
		}
		if (editTool === 'select' && session && (e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey) && session.selectionIds.size > 0) {
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
			if (!symbolChooserEl.classList.contains('hidden') || editTool === 'place-symbol') {
				// Covers both the chooser being open AND the armed-but-not-
				// yet-clicked state (tool active, modal not open yet) —
				// cancelSymbolPlacement handles either safely.
				cancelSymbolPlacement();
			}
			else if (!propertiesModalEl.classList.contains('hidden')) {
				closePropertiesModal();
			}
			else if (!contextMenuEl.classList.contains('hidden')) {
				closeContextMenu();
			}
			else if (lineChainStart || shapeAnchor || arcPoints.length || bezierPoints.length) {
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
		if ((e.key === 'Delete' || e.key === 'Backspace') && editTool === 'select' && session && session.selectionIds.size > 0) {
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
				lastFullSch = s.getSchematicText() || lastFullSch;
			}
			if (skippedSymbols && !removed) {
				setStatus("Symbols aren't deletable in edit mode.");
			}
			else if (skippedSymbols) {
				setStatus(`Deleted ${removed} item(s); ${skippedSymbols} symbol(s) skipped (not deletable in edit mode).`);
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

	if (mode !== 'circuit' || !circuitDragMode) return;
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
	if ((!circuitDragMode && mode !== 'edit') || !selectedRef || !session) {
		setStatus('Click a component first, then press T to tidy its labels.');
		return;
	}
	// Only meaningful in edit mode — circuit mode's placements are always
	// reference-unique on their own (no multi-unit concept there), and
	// editSelectedId may hold a stale id from an earlier edit-mode selection.
	const instanceId = mode === 'edit' ? (editSelectedId ?? undefined) : undefined;
	const pose = session.getSymbolPose(selectedRef, instanceId);
	if (!pose) {
		return;
	}
	const pins = lockedNetlist ? pinsForLockedLib(pose.libId, lockedNetlist.pinsByLib) : [];
	const layout = symbolFieldLayout(pose.libId, pose.x, pose.y, pose.rotation, pins);
	session.pushUndoSnapshot();
	if (session.autoplaceSymbolFields(selectedRef, layout, instanceId)) {
		lastFullSch = session.getSchematicText() || lastFullSch;
		setStatus(`Tidied labels for ${selectedRef}.`);
	}
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
		const bbox = hitItems.find(it => it.id === id)?.bbox;
		return { sourceText, x: bbox?.x ?? 0, y: bbox?.y ?? 0 };
	});
	const systemText = s.copySelectionForSystemClipboard(ids);
	if (systemText) {
		void navigator.clipboard?.writeText(systemText).catch(() => { /* best-effort only */ });
	}
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
		setStatus(symbolCount ? "Symbols aren't deletable in edit mode." : 'Nothing to cut.');
		return;
	}
	copySelectionToClipboard(s, ids);
	const removed = s.deleteElements(ids);
	if (removed) {
		lastFullSch = s.getSchematicText() || lastFullSch;
	}
	syncSingleSelectionBookkeeping(s);
	setStatus(symbolCount
		? `Cut ${removed} item(s); ${symbolCount} symbol(s) skipped (not deletable in edit mode).`
		: `Cut ${removed} item(s).`);
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
	lastFullSch = s.getSchematicText() || lastFullSch;
	setStatus(`Pasted ${newIds.length} item(s).`);
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
	let systemText: string | null = null;
	try {
		systemText = (await navigator.clipboard?.readText()) || null;
	}
	catch {
		systemText = null;
	}
	if (systemText) {
		const newIds = s.pasteSystemClipboardText(systemText, targetWorld.x, targetWorld.y);
		if (newIds.length > 0) {
			s.selectMultiple(newIds, 'replace');
			syncSingleSelectionBookkeeping(s);
			lastFullSch = s.getSchematicText() || lastFullSch;
			setStatus(`Pasted ${newIds.length} item(s) from clipboard.`);
			updateEditSidebar();
			return;
		}
	}
	if (clipboard.length > 0) {
		pasteClipboardAt(s, targetWorld);
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
	lastFullSch = s.getSchematicText() || lastFullSch;
	setStatus(`Duplicated ${newIds.length} item(s).`);
	updateEditSidebar();
}

// ---- Group / Ungroup ----
// Named groupSelectedElements/ungroupSelectedElements (never a bare
// "Group"-prefixed name) to stay clear of the unrelated TOOL_GROUPS/
// ToolGroupDef/cycleGroup/groupDrag identifiers already in this file for
// the cyclable-toolbar-button concept (Label/Shape tool groups) — same
// word, unrelated feature.

function groupSelectedElements(s: KicadRenderSession): void {
	const groupUuid = s.groupSelection([...s.selectionIds]);
	if (!groupUuid) {
		return;
	}
	lastFullSch = s.getSchematicText() || lastFullSch;
	setStatus('Grouped selection.');
	updateEditSidebar();
}

function ungroupSelectedElements(s: KicadRenderSession): void {
	const removed = s.ungroupSelection([...s.selectionIds]);
	if (removed === 0) {
		return;
	}
	lastFullSch = s.getSchematicText() || lastFullSch;
	setStatus(removed === 1 ? 'Ungrouped.' : `Ungrouped ${removed} group(s).`);
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
	pendingTableAnchor = null;
	pendingTableId = null;
	tableModal.classList.add('hidden');
	propertiesModalEl.classList.add('hidden');
	currentLabelShape = 'input';
	currentDirectiveLabelShape = 'round';
	editDragId = null;
	editDragLastPos = null;
	resizeDrag = null;
	curveDrag = null;
	rectSelectDrag = null;
	groupDrag = null;
	hideTextInput();
	closeContextMenu();
	session?.setEditPreview(null);
}

function setEditTool(tool: EditTool): void {
	if (tool !== 'place-symbol') {
		pendingSymbol = null;
		pendingUnitState = null;
	}
	editTool = tool;
	resetEditToolState();
	syncGroupButtonForTool(tool);
	for (const btn of editToolButtons) {
		btn.classList.toggle('active', btn.dataset.tool === tool);
	}
	updateCircuitHint();
}

function hideTextInput(): void {
	editTextInput.classList.add('hidden');
	editTextInput.value = '';
	editTextBoxInput.classList.add('hidden');
	editTextBoxInput.value = '';
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
function showTextInputAt(worldAnchor: Vec2, clientX: number, clientY: number, placeholder: string, initialValue: string): void {
	pendingTextAnchor = worldAnchor;
	// clientX/clientY, NOT screenPosFromEvent()'s output — that's DPR-scaled
	// for canvas-buffer hit-testing and would misposition an HTML overlay.
	const stageRect = stage.getBoundingClientRect();
	editTextInput.style.left = `${clientX - stageRect.left}px`;
	editTextInput.style.top = `${clientY - stageRect.top}px`;
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
	showTextInputAt(worldAnchor, e.clientX, e.clientY, TEXT_INPUT_PLACEHOLDERS[editTool] ?? '', '');
}

function showTextBoxInput(first: Vec2, second: Vec2, e: MouseEvent): void {
	pendingTextBoxBounds = {
		x: Math.min(first.x, second.x), y: Math.min(first.y, second.y),
		width: Math.abs(second.x - first.x), height: Math.abs(second.y - first.y),
	};
	const stageRect = stage.getBoundingClientRect();
	editTextBoxInput.style.left = `${e.clientX - stageRect.left}px`;
	editTextBoxInput.style.top = `${e.clientY - stageRect.top}px`;
	editTextBoxInput.classList.remove('hidden');
	editTextBoxInput.focus();
	session?.setEditPreview(previewForPendingTextBox(''));
}

function showTableModal(anchor: Vec2): void {
	pendingTableId = null;
	pendingTableAnchor = anchor;
	tableModal.classList.remove('hidden');
	tableDataInput.focus();
}

function showTableEditModal(id: string): void {
	const table = getHitElement(id);
	const cellsRoot = table?.findFirstChildByName?.('cells');
	const cells = cellsRoot?.findChildrenByName?.('table_cell') ?? [];
	if (!table || !cells.length) return;
	const columns = Number(table.findFirstChildByName?.('column_count')?.attributes?.[0]?.value) || 1;
	const rows = Math.max(1, Math.ceil(cells.length / columns));
	const firstOrigin = cells[0]?.getOrigin?.() ?? { x: 0, y: 0 };
	tableRowsInput.value = String(rows);
	tableColumnsInput.value = String(columns);
	tableDataInput.value = Array.from({ length: rows }, (_, row) =>
		Array.from({ length: columns }, (_, column) => String(cells[row * columns + column]?.value ?? '')).join('\t')
	).join('\n');
	pendingTableId = id;
	pendingTableAnchor = new Vec2(firstOrigin.x, firstOrigin.y);
	tableModal.classList.remove('hidden');
	tableDataInput.focus();
}

/** Double-click-to-edit for every non-table kind — reuses whichever
 *  renderXProperties() function updateEditSidebar() would already dispatch
 *  to for this hit, just pointed at the modal body instead of the sidebar
 *  via propertyTargetEl. Selecting first (not just reading the hit) keeps
 *  this in lock-step with what a plain click already does, and means the
 *  sidebar naturally shows the same element once the modal closes.
 *
 *  Cleared BEFORE rendering (not just checked after) so a kind with no
 *  dedicated panel — updateEditSidebar()'s default case writes straight to
 *  editPropertiesEl, never touching propertyTargetEl — can't leave a STALE
 *  modal body from a previous, different double-click behind; children.length
 *  after the render is what decides whether a real panel exists to show. */
function showPropertiesModal(hitId: string): void {
	const s = session;
	if (!s) return;
	s.select(hitId);
	propertiesModalBodyEl.innerHTML = '';
	propertiesModalTitleEl.textContent = 'Properties';
	const hit = s.activeScene?.hitTestItems.find(item => item.id === hitId);
	const element = (hit as any)?.element;
	if (!hit || !element) {
		return;
	}
	const labelKind = (hit as any).labelKind as string | undefined;
	switch (hit.kind) {
		case 'symbol':
			renderSymbolDialog(element, hit.id);
			break;
		case 'symbol-graphic':
			renderShapeDialog(element, hit.kind, hit.id);
			break;
		case 'wire':
		case 'bus':
			renderWireBusDialog(element, hit.kind, hit.id);
			break;
		case 'junction':
			renderJunctionDialog(element, hit.id);
			break;
		case 'text':
			// Same gate as updateEditSidebar's own dispatch — table cells also
			// carry kind:'text' but have a wholly different property surface
			// (row/col span, per-cell margins) out of scope here either way.
			if (element.name === 'text' || element.name === 'text_box') {
				renderTextDialog(element, hit.id);
			}
			break;
		case 'label':
			renderLabelDialog(element, labelKind, hit.id);
			break;
		default:
			break;
	}
	if (!propertiesModalBodyEl.children.length) {
		return;
	}
	propertiesModalEl.classList.remove('hidden');
	updateUndoStackPane();
}

/** Refreshes the real sidebar on close (propertyTargetEl is already back to
 *  editPropertiesEl by then) so it picks up whatever the modal's live edits
 *  left behind — the fields inside commit immediately on change, same as
 *  the sidebar's own fields, so there's nothing to "save" here. */
function closePropertiesModal(): void {
	propertiesModalEl.classList.add('hidden');
	propertiesModalBodyEl.innerHTML = '';
	updateEditSidebar();
}
document.getElementById('properties-modal-close')?.addEventListener('click', () => {
	closePropertiesModal();
});

document.getElementById('table-cancel')?.addEventListener('click', () => {
	pendingTableAnchor = null;
	pendingTableId = null;
	tableModal.classList.add('hidden');
});
document.getElementById('table-insert')?.addEventListener('click', () => {
	const anchor = pendingTableAnchor;
	if (!anchor || !session) return;
	const rows = Math.max(1, Math.min(30, Number(tableRowsInput.value) || 1));
	const columns = Math.max(1, Math.min(20, Number(tableColumnsInput.value) || 1));
	const values = tableDataInput.value.split(/\r?\n/).map(row => row.split('\t'));
	if (pendingTableId) {
		session.deleteElements([pendingTableId]);
	}
	if (session.addGraphicTable(anchor.x, anchor.y, rows, columns, values)) {
		lastFullSch = session.getSchematicText() || lastFullSch;
		setStatus('Added table.');
	}
	pendingTableAnchor = null;
	pendingTableId = null;
	tableModal.classList.add('hidden');
});
tableDataInput.addEventListener('keydown', (event) => {
	if (event.key !== 'Tab') return;
	event.preventDefault();
	const start = tableDataInput.selectionStart;
	const end = tableDataInput.selectionEnd;
	const value = tableDataInput.value;
	tableDataInput.value = value.slice(0, start) + '\t' + value.slice(end);
	tableDataInput.selectionStart = tableDataInput.selectionEnd = start + 1;
});

/** Context menu's "Edit Text…" — reuses the floating text input to rename
 *  an EXISTING label in place, pre-filled with its current text, positioned
 *  at the label's own world position rather than wherever was right-clicked. */
function showEditLabelInput(id: string): void {
	const el = getHitElement(id);
	if (!el || !session) {
		return;
	}
	const currentText = typeof el.getName === 'function' ? el.getName() : String(el.value ?? '');
	const origin = typeof el.getOrigin === 'function' ? el.getOrigin() : { x: 0, y: 0 };
	const worldAnchor = new Vec2(origin.x, origin.y);
	const sp = session.camera.worldToScreen(worldAnchor);
	const canvasRect = canvas.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	editingLabelId = id;
	showTextInputAt(worldAnchor, canvasRect.left + sp.x / dpr, canvasRect.top + sp.y / dpr, 'Edit text…', currentText);
}

function commitTextInput(): void {
	const value = editTextInput.value.trim();
	if (editingLabelId) {
		const id = editingLabelId;
		if (value && session && session.renameLabel(id, value)) {
			lastFullSch = session.getSchematicText() || lastFullSch;
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
			setStatus(`Added text "${value}".`);
			break;
		case 'label':
			session.addLabel(anchor.x, anchor.y, value);
			setStatus(`Added label "${value}".`);
			break;
		case 'directive-label':
			session.addDirectiveLabel(anchor.x, anchor.y, value, currentDirectiveLabelShape);
			setStatus(`Added directive label "${value}" (${currentDirectiveLabelShape}).`);
			break;
		case 'global-label':
			session.addGlobalLabel(anchor.x, anchor.y, value, currentLabelShape);
			setStatus(`Added global label "${value}" (${currentLabelShape}).`);
			break;
		case 'hier-label':
			session.addHierLabel(anchor.x, anchor.y, value, currentLabelShape);
			setStatus(`Added hierarchical label "${value}" (${currentLabelShape}).`);
			break;
		case 'power':
			// Only reachable when currentPowerKind is 'rail' — gnd/flag commit
			// one-click in handleEditModeMouseDown and never open this input.
			session.addPowerRail(anchor.x, anchor.y, value);
			setStatus(`Added power rail "${value}".`);
			break;
		default:
			break;
	}
	lastFullSch = session.getSchematicText() || lastFullSch;
	hideTextInput();
	session.setEditPreview(null);
}

function commitTextBoxInput(): void {
	const value = editTextBoxInput.value.trim();
	const bounds = pendingTextBoxBounds;
	if (value && bounds && session) {
		session.addGraphicTextBox(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height, value);
		lastFullSch = session.getSchematicText() || lastFullSch;
		setStatus('Added text box.');
	}
	hideTextInput();
	session?.setEditPreview(null);
}

editTextInput.addEventListener('input', () => {
	if (pendingTextAnchor) {
		session?.setEditPreview(previewForPendingText(pendingTextAnchor, editTextInput.value));
	}
});
editTextInput.addEventListener('keydown', (e) => {
	// Own local handler — the global keydown listener already bails on a
	// focused INPUT, but stop propagation defensively regardless.
	e.stopPropagation();
	if (e.key === 'Enter') {
		e.preventDefault();
		commitTextInput();
	}
	else if (e.key === 'Escape') {
		e.preventDefault();
		hideTextInput();
		session?.setEditPreview(null);
	}
	else if (e.key === 'Tab' && !editingLabelId && (editTool === 'global-label' || editTool === 'hier-label')) {
		e.preventDefault();
		const idx = LABEL_SHAPES.indexOf(currentLabelShape);
		currentLabelShape = LABEL_SHAPES[(idx + 1) % LABEL_SHAPES.length]!;
		if (pendingTextAnchor) {
			session?.setEditPreview(previewForPendingText(pendingTextAnchor, editTextInput.value));
		}
		updateCircuitHint();
	}
	else if (e.key === 'Tab' && !editingLabelId && editTool === 'directive-label') {
		e.preventDefault();
		const idx = DIRECTIVE_LABEL_SHAPES.indexOf(currentDirectiveLabelShape);
		currentDirectiveLabelShape = DIRECTIVE_LABEL_SHAPES[(idx + 1) % DIRECTIVE_LABEL_SHAPES.length]!;
		if (pendingTextAnchor) {
			session?.setEditPreview(previewForPendingText(pendingTextAnchor, editTextInput.value));
		}
		updateCircuitHint();
	}
});
editTextInput.addEventListener('blur', () => {
	// classList.add('hidden') on a focused input forces a synchronous blur —
	// this guard stops that from re-entering commit/cancel a second time.
	if (editTextInput.classList.contains('hidden')) {
		return;
	}
	if (editTextInput.value.trim()) {
		commitTextInput();
	}
	else {
		hideTextInput();
		session?.setEditPreview(null);
	}
});

editTextBoxInput.addEventListener('input', () => {
	session?.setEditPreview(previewForPendingTextBox(editTextBoxInput.value));
});
editTextBoxInput.addEventListener('keydown', (e) => {
	e.stopPropagation();
	if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		commitTextBoxInput();
	}
	else if (e.key === 'Escape') {
		e.preventDefault();
		hideTextInput();
		session?.setEditPreview(null);
	}
});
editTextBoxInput.addEventListener('blur', () => {
	if (editTextBoxInput.classList.contains('hidden')) {
		return;
	}
	commitTextBoxInput();
});

// ---- Edit mode: right-click context menu ----

/** Same idiom already used by the circuit-mode label-drag code (main.ts's
 *  mousedown handler) for reaching the live AST element behind a paint-item
 *  id — schScene isn't part of KicadRenderSession's public surface. */
function getHitElement(id: string): any {
	return (session as any)?.schScene?.hitTestItems?.find((it: any) => it.id === id)?.element;
}

function menuItem(label: string, onSelect: () => void, disabled = false): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'menu-item';
	btn.textContent = label;
	btn.disabled = disabled;
	btn.addEventListener('click', () => {
		closeContextMenu();
		onSelect();
	});
	return btn;
}

function menuSeparator(): HTMLDivElement {
	const div = document.createElement('div');
	div.className = 'separator';
	return div;
}

function deleteHit(s: KicadRenderSession, id: string): void {
	if (s.deleteElements([id])) {
		lastFullSch = s.getSchematicText() || lastFullSch;
		setStatus('Deleted.');
	}
}

/** Built from the live toolbar buttons (editToolButtons), not a
 *  hand-duplicated list — label/disabled state can never drift out of sync
 *  with the actual tool panel this way. */
function buildPlaceSubmenu(): HTMLDivElement {
	const wrap = document.createElement('div');
	wrap.className = 'submenu-wrap';
	const trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.className = 'menu-item';
	trigger.textContent = 'Place ▸';
	trigger.addEventListener('click', (e) => {
		e.stopPropagation();
		wrap.classList.toggle('open');
	});
	const submenu = document.createElement('div');
	submenu.className = 'submenu';
	for (const btn of editToolButtons) {
		// A collapsed group button shows only its current member on the
		// toolbar, but the Place submenu is the exhaustive command list —
		// expand it back into one row per member so nothing hides behind an
		// undiscovered right-click-to-cycle gesture.
		const group = TOOL_GROUPS.find(g => g.buttonId === btn.id);
		if (group) {
			for (const member of group.members) {
				submenu.appendChild(menuItem(member.menuLabel, () => setEditTool(member.tool), false));
			}
			continue;
		}
		const tool = btn.dataset.tool as EditTool | undefined;
		if (!tool) {
			continue;
		}
		submenu.appendChild(menuItem(btn.title || tool, () => {
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
		}, btn.disabled));
	}
	wrap.appendChild(trigger);
	wrap.appendChild(submenu);
	return wrap;
}

const ALIGN_AXES: { axis: AlignAxis; label: string }[] = [
	{ axis: 'left', label: 'Align Left' },
	{ axis: 'right', label: 'Align Right' },
	{ axis: 'top', label: 'Align Top' },
	{ axis: 'bottom', label: 'Align Bottom' },
	{ axis: 'center-x', label: 'Align Center Horizontally' },
	{ axis: 'center-y', label: 'Align Center Vertically' },
];

/** Context-menu-only, no hotkey — same choice already made for Mirror
 *  (index.html/main.ts's right-click Mirror Vertically/Horizontally
 *  entries): no clean single-key mnemonic exists for 6 directions without
 *  colliding with an existing edit-tool hotkey. */
function buildAlignSubmenu(s: KicadRenderSession, ids: string[]): HTMLDivElement {
	const wrap = document.createElement('div');
	wrap.className = 'submenu-wrap';
	const trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.className = 'menu-item';
	trigger.textContent = 'Align ▸';
	trigger.disabled = ids.length < 2;
	trigger.addEventListener('click', (e) => {
		e.stopPropagation();
		wrap.classList.toggle('open');
	});
	const submenu = document.createElement('div');
	submenu.className = 'submenu';
	for (const { axis, label } of ALIGN_AXES) {
		submenu.appendChild(menuItem(label, () => {
			if (s.alignSelection(ids, axis)) {
				lastFullSch = s.getSchematicText() || lastFullSch;
				updateUndoStackPane();
				setStatus(`Aligned ${ids.length} item(s).`);
			}
		}, ids.length < 2));
	}
	wrap.appendChild(trigger);
	wrap.appendChild(submenu);
	return wrap;
}

function closeContextMenu(): void {
	contextMenuEl.classList.add('hidden');
	contextMenuEl.innerHTML = '';
}

function showContextMenu(items: HTMLElement[], clientX: number, clientY: number): void {
	contextMenuEl.innerHTML = '';
	for (const item of items) {
		contextMenuEl.appendChild(item);
	}
	contextMenuEl.classList.remove('hidden');
	const stageRect = stage.getBoundingClientRect();
	const menuRect = contextMenuEl.getBoundingClientRect();
	const left = Math.min(clientX - stageRect.left, Math.max(0, stageRect.width - menuRect.width));
	const top = Math.min(clientY - stageRect.top, Math.max(0, stageRect.height - menuRect.height));
	contextMenuEl.style.left = `${left}px`;
	contextMenuEl.style.top = `${top}px`;
}

canvas.addEventListener('contextmenu', (e) => {
	if (mode !== 'edit') {
		return;
	}
	e.preventDefault();
	// Right-click during an in-progress multi-click placement (wire/bus
	// chain, line/rect/circle anchor, arc points) ends it, same as Escape —
	// a context menu popping up mid-chain would be a worse UX than just
	// stopping, and matches KiCad's own right-click-to-finish convention.
	if (lineChainStart || shapeAnchor || arcPoints.length || bezierPoints.length || ruleAreaPoints.length) {
		resetEditToolState();
		return;
	}
	const s = ensureSession();
	const hit = s.hitTestAtScreen(screenPosFromEvent(e));
	const items: HTMLElement[] = [];

	// Keyed off the SELECTION, not the right-click target — real KiCad's
	// zoomFitSelection has no default hotkey (common/tool/actions.cpp),
	// menu-only, same choice made here rather than picking an arbitrary key.
	if (s.selectionIds.size > 0) {
		items.push(menuItem('Zoom to Selection', () => {
			const selected = s.activeScene?.hitTestItems.filter(it => s.selectionIds.has(it.id)) ?? [];
			s.fitToItems(selected);
		}));
		items.push(buildAlignSubmenu(s, [...s.selectionIds]));
		items.push(menuSeparator());
		const selectedIds = [...s.selectionIds];
		items.push(menuItem('Copy', () => {
			const count = copySelectionToClipboard(s, copyableIds(s, selectedIds));
			setStatus(`Copied ${count} item(s).`);
		}));
		items.push(menuItem('Cut', () => cutSelectionToClipboard(s)));
		items.push(menuItem('Duplicate', () => duplicateSelectedElements(s)));
		items.push(menuItem('Group', () => groupSelectedElements(s), selectedIds.length < 2));
		items.push(menuItem('Ungroup', () => ungroupSelectedElements(s), !s.selectionHasGroup(selectedIds)));
		items.push(menuSeparator());
	}
	// Always shown, not gated on clipboard.length — the OS clipboard (tried
	// first inside pasteAtWorld) may hold real-KiCad content even when this
	// app's own in-app array is empty, and there's no cheap synchronous way
	// to check navigator.clipboard's contents while building this menu.
	// pasteAtWorld itself reports "Nothing to paste." if neither source has
	// anything.
	items.push(menuItem('Paste', () => void pasteAtWorld(s, s.screenToWorld(screenPosFromEvent(e)))));
	items.push(menuSeparator());

	if (hit) {
		if (hit.kind === 'symbol' && hit.refDesignator) {
			const ref = hit.refDesignator;
			items.push(menuItem('Rotate', () => {
				selectedRef = ref;
				s.select(hit.id);
				void rotateSelected();
			}));
			items.push(menuItem('Tidy Labels', () => {
				selectedRef = ref;
				s.select(hit.id);
				autoplaceSelectedFields();
			}));
			// Axis mapping is deliberately NOT "vertical=y, horizontal=x" —
			// confirmed directly against real KiCad source (eeschema/tools/
			// sch_edit_tool.cpp's SCH_EDIT_TOOL::Mirror, cross-checked all the
			// way to the file writer in sch_io_kicad_sexpr.cpp): "Mirror
			// Vertically" (flips top-to-bottom) sets SYM_MIRROR_X → writes
			// `(mirror x)`; "Mirror Horizontally" (flips left-to-right) sets
			// SYM_MIRROR_Y → writes `(mirror y)`. Real KiCad's own source has
			// a comment noting these were genuinely backwards pre-6.0 and got
			// fixed — this is the corrected, current mapping, not a guess.
			items.push(menuItem('Mirror Vertically', () => {
				s.mutateSymbolByPaintId(hit.id, symbol => {
					symbol.setMirror(symbol.getMirror() === 'x' ? null : 'x');
				});
				lastFullSch = s.getSchematicText() || lastFullSch;
			}));
			items.push(menuItem('Mirror Horizontally', () => {
				s.mutateSymbolByPaintId(hit.id, symbol => {
					symbol.setMirror(symbol.getMirror() === 'y' ? null : 'y');
				});
				lastFullSch = s.getSchematicText() || lastFullSch;
			}));
		}
		else if (hit.kind === 'label') {
			items.push(menuItem('Delete', () => deleteHit(s, hit.id)));
			items.push(menuItem('Edit Text…', () => showEditLabelInput(hit.id)));
			if (hit.labelKind === 'global' || hit.labelKind === 'hier' || hit.labelKind === 'directive') {
				const shapes: readonly string[] = hit.labelKind === 'directive' ? DIRECTIVE_LABEL_SHAPES : LABEL_SHAPES;
				items.push(menuItem('Cycle Shape', () => {
					const el = getHitElement(hit.id);
					if (!el || typeof el.getShape !== 'function') {
						return;
					}
					const idx = shapes.indexOf(el.getShape());
					const next = shapes[(idx + 1) % shapes.length]!;
					if (s.setLabelShape(hit.id, next as KicadGlobalLabelShape | KicadDirectiveLabelShape)) {
						lastFullSch = s.getSchematicText() || lastFullSch;
						setStatus(`Shape: ${next}.`);
					}
				}));
			}
		}
		else {
			items.push(menuItem('Delete', () => deleteHit(s, hit.id)));
		}
		items.push(menuSeparator());
	}
	items.push(buildPlaceSubmenu());

	showContextMenu(items, e.clientX, e.clientY);
});

window.addEventListener('click', (e) => {
	if (!contextMenuEl.classList.contains('hidden') && !contextMenuEl.contains(e.target as Node)) {
		closeContextMenu();
	}
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
					width: Math.abs(cursor.x - shapeAnchor.x), height: Math.abs(cursor.y - shapeAnchor.y), text: '',
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
			curveDrag = { id: curveAnchor.curve.id, anchor: curveAnchor.anchor };
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
				editDragId = resizeHandle.box.id;
				editDragLastPos = snapped;
			}
			else {
				resizeDrag = { id: resizeHandle.box.id, handle: resizeHandle.handle, original: resizeHandle.box };
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
				groupDrag = { lastSnapped: snapped };
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
			groupDrag = { lastSnapped: snapped };
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
		if (hit) {
			// Local/global/hier labels land here too (kind:'label') — draggable
			// and deletable like any other edit-mode element (see the
			// Delete/Backspace handler above, which only excludes 'symbol').
			selectedRef = null;
			editSelectedId = hit.id;
			editSelectedKind = hit.kind;
			s.select(hit.id);
			s.pushUndoSnapshot();
			editDragId = hit.id;
			editDragLastPos = snapped;
			e.preventDefault();
			return true;
		}
		// Empty space: start a rectangle-select drag rather than clearing
		// immediately — selection itself is deferred entirely to mouseup (see
		// onPointerUp's rectSelectDrag branch), so an in-progress modifier
		// change doesn't produce an inconsistent intermediate state. Every
		// OTHER edit-mode tool already returns true unconditionally here with
		// no left-drag-pan, so this makes the select tool consistent with the
		// rest rather than newly inconsistent — middle-drag/wheel-zoom still
		// pan/zoom regardless.
		rectSelectDrag = { originWorld: worldPos, originScreen: screenPos };
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
			lastFullSch = s.getSchematicText() || lastFullSch;
			lineChainStart = snapped;
		}
		e.preventDefault();
		return true;
	}

	if (editTool === 'bus-entry') {
		s.addBusEntry(snapped.x, snapped.y);
		lastFullSch = s.getSchematicText() || lastFullSch;
		e.preventDefault();
		return true;
	}

	if (editTool === 'junction') {
		s.addJunction(snapped.x, snapped.y);
		lastFullSch = s.getSchematicText() || lastFullSch;
		e.preventDefault();
		return true;
	}

	if (editTool === 'no-connect') {
		s.addNoConnect(snapped.x, snapped.y);
		lastFullSch = s.getSchematicText() || lastFullSch;
		e.preventDefault();
		return true;
	}

	if (editTool === 'place-symbol') {
		if (e.button === 0) {
			if (pendingSymbol) {
				// Repeat-placement mode: a symbol's already chosen, place
				// directly without reopening the chooser.
				void beginPendingSymbolPlacement(snapped);
			}
			else {
				// First click since arming — this IS the placement point;
				// remember it and open the chooser now so the user can see
				// where it'll land before picking what goes there.
				pendingSymbolAnchor = snapped;
				void openSymbolChooser();
			}
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
			lastFullSch = s.getSchematicText() || lastFullSch;
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
			lastFullSch = s.getSchematicText() || lastFullSch;
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
					lastFullSch = s.getSchematicText() || lastFullSch;
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
			lastFullSch = s.getSchematicText() || lastFullSch;
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
		lastFullSch = s.getSchematicText() || lastFullSch;
		e.preventDefault();
		return true;
	}

	if (editTool === 'delete') {
		const hit = s.hitTestAtScreen(screenPos);
		if (hit) {
			if (hit.kind === 'symbol') {
				setStatus("Symbols aren't deletable in edit mode.");
			}
			else {
				const removed = s.deleteElements([hit.id]);
				if (removed) {
					lastFullSch = s.getSchematicText() || lastFullSch;
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
	if (!file) return;
	void openKiCadFile(file);
});

// ---- Property panel: shared DOM builder helpers (module scope so every
// render*Properties function below can reuse them, not just symbols) ----

function propertySection(title: string): HTMLElement {
  const s = document.createElement('section'); s.className = 'property-section';
  const h = document.createElement('div'); h.className = 'property-section-title'; h.textContent = title;
  s.appendChild(h); propertyTargetEl.appendChild(s); return s;
}

function propertyRow(s: HTMLElement, label: string, value: string, edit = false, save?: (v: string) => void): void {
  const r = document.createElement('div'); r.className = 'property-row';
  const l = document.createElement('div'); l.className = 'property-label'; l.textContent = label;
  const c = document.createElement('div'); c.className = 'property-value';
  if (edit) {
    const i = document.createElement('input'); i.className = 'property-input'; i.value = value;
    const commit = () => { if (i.value !== value) { value = i.value; save?.(value); } };
    i.addEventListener('change', commit);
    i.addEventListener('keydown', e => { if (e.key === 'Enter') { commit(); i.blur(); } });
    c.appendChild(i);
  }
  else {
    c.textContent = value;
  }
  r.append(l, c); s.appendChild(r);
}

function propertySelectRow(s: HTMLElement, label: string, value: string, options: { value: string, label: string }[], save: (v: string) => void): void {
  const r = document.createElement('div'); r.className = 'property-row';
  const l = document.createElement('div'); l.className = 'property-label'; l.textContent = label;
  const c = document.createElement('div'); c.className = 'property-value';
  const select = document.createElement('select'); select.className = 'property-input';
  for (const option of options) {
    const item = document.createElement('option'); item.value = option.value; item.textContent = option.label;
    select.appendChild(item);
  }
  select.value = options.some(o => o.value === value) ? value : (options[0]?.value ?? '');
  select.addEventListener('change', () => save(select.value));
  c.appendChild(select); r.append(l, c); s.appendChild(r);
}

/** Convenience wrapper for the common case (angle dropdowns etc.) where the
 *  option's displayed label is just the raw value. */
function propertyOrientationRow(s: HTMLElement, label: string, value: string, options: string[], save: (v: string) => void): void {
  propertySelectRow(s, label, value, options.map(o => ({ value: o, label: `${o}°` })), save);
}

function propertyCheckRow(s: HTMLElement, label: string, checked: boolean, save: (v: boolean) => void): void {
  const r = document.createElement('div'); r.className = 'property-row';
  const l = document.createElement('div'); l.className = 'property-label'; l.textContent = label;
  const c = document.createElement('div'); c.className = 'property-value';
  const i = document.createElement('input'); i.type = 'checkbox'; i.className = 'property-check'; i.checked = checked;
  i.addEventListener('change', () => save(i.checked));
  c.appendChild(i); r.append(l, c); s.appendChild(r);
}

/** `value` is a resolved CSS color string (e.g. from an rgba(…) getter) or
 *  null/undefined for "no explicit color set" (shown as a neutral gray
 *  swatch — native <input type=color> has no true "unset" state). Native
 *  color inputs have no alpha channel either, so a pick always commits full
 *  opacity — an accepted v1 scope cut rather than building a custom
 *  alpha-slider widget; nothing in this app's own rendering currently
 *  relies on partial alpha for these fields anyway. */
function propertyColorRow(s: HTMLElement, label: string, value: string | null | undefined, save: (hex: string) => void): void {
  const r = document.createElement('div'); r.className = 'property-row';
  const l = document.createElement('div'); l.className = 'property-label'; l.textContent = label;
  const c = document.createElement('div'); c.className = 'property-value';
  const i = document.createElement('input'); i.type = 'color'; i.className = 'property-input';
  i.value = cssColorToHex(value) ?? '#808080';
  i.addEventListener('change', () => save(i.value));
  c.appendChild(i); r.append(l, c); s.appendChild(r);
}

/** Parses 'rgb(r,g,b)'/'rgba(r,g,b,a)' into a '#rrggbb' hex string for
 *  <input type=color>. Returns null for anything else (unset/unparseable)
 *  so callers can fall back to a neutral placeholder instead of black. */
function cssColorToHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!m) return null;
  const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
  return `#${toHex(m[1]!)}${toHex(m[2]!)}${toHex(m[3]!)}`;
}

/** '#rrggbb' -> the 0-255 int triple every kicad-io setColor(r,g,b,a) call
 *  expects (alpha always 1 — see propertyColorRow's doc comment). */
function hexToRgb255(hex: string): [number, number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
}

// ---- Native-dialog primitives (double-click properties modal) ----
// Deliberately separate from propertySection/propertyRow above: those are
// implicitly targeted (always append to the module-level propertyTargetEl),
// which works for the sidebar's flat list of sections but not for a dialog
// that nests a section INSIDE one half of a 2-column layout — every
// function here takes its container explicitly instead. Section boxes
// still reuse .property-section/.property-section-title for visual
// consistency with the sidebar (same bordered-box-with-header-bar look);
// everything else (multi-control rows, columns, grid) is new since the
// sidebar's rigid label|value 2-column row never needed to pack e.g.
// "Width: [input] mm   Color: [swatch]" onto one line.

function kdSection(container: HTMLElement, title: string): HTMLElement {
  const s = document.createElement('section'); s.className = 'property-section kd-section';
  const h = document.createElement('div'); h.className = 'property-section-title'; h.textContent = title;
  s.appendChild(h); container.appendChild(s); return s;
}

/** Two panes side by side, each flex:1 — e.g. Border|Fill, General|Attributes. */
function kdColumns(container: HTMLElement): [HTMLElement, HTMLElement] {
  const wrap = document.createElement('div'); wrap.className = 'kd-columns';
  const left = document.createElement('div'); const right = document.createElement('div');
  wrap.append(left, right); container.appendChild(wrap);
  return [left, right];
}

function kdRow(container: HTMLElement): HTMLElement {
  const r = document.createElement('div'); r.className = 'kd-row'; container.appendChild(r); return r;
}

function kdLabel(row: HTMLElement, text: string): void {
  const l = document.createElement('span'); l.className = 'kd-label'; l.textContent = text; row.appendChild(l);
}

function kdUnit(row: HTMLElement, text: string): void {
  const u = document.createElement('span'); u.className = 'kd-unit'; u.textContent = text; row.appendChild(u);
}

function kdTextInput(row: HTMLElement, value: string, save: (v: string) => void, numeric = false): HTMLInputElement {
  const i = document.createElement('input'); i.className = 'kd-input' + (numeric ? ' kd-input-num' : '');
  i.value = value;
  const commit = () => { if (i.value !== value) save(i.value); };
  i.addEventListener('change', commit);
  i.addEventListener('keydown', e => { if (e.key === 'Enter') { commit(); i.blur(); } });
  row.appendChild(i);
  return i;
}

function kdSelect(row: HTMLElement, value: string, options: { value: string, label: string }[], save: (v: string) => void): HTMLSelectElement {
  const select = document.createElement('select'); select.className = 'kd-input';
  for (const o of options) { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; select.appendChild(opt); }
  select.value = options.some(o => o.value === value) ? value : (options[0]?.value ?? '');
  select.addEventListener('change', () => save(select.value));
  row.appendChild(select);
  return select;
}

function kdSwatch(row: HTMLElement, value: string | null | undefined, save: (hex: string) => void): void {
  const i = document.createElement('input'); i.type = 'color'; i.className = 'kd-swatch';
  i.value = cssColorToHex(value) ?? '#808080';
  i.addEventListener('change', () => save(i.value));
  row.appendChild(i);
}

function kdCheckRow(container: HTMLElement, label: string, checked: boolean, save: (v: boolean) => void): HTMLInputElement {
  const r = document.createElement('label'); r.className = 'kd-check-row';
  const i = document.createElement('input'); i.type = 'checkbox'; i.checked = checked;
  i.addEventListener('change', () => save(i.checked));
  const span = document.createElement('span'); span.textContent = label;
  r.append(i, span); container.appendChild(r);
  return i;
}

function kdRadioRow(container: HTMLElement, groupName: string, label: string, checked: boolean, save: () => void): void {
  const r = document.createElement('label'); r.className = 'kd-radio-row';
  const i = document.createElement('input'); i.type = 'radio'; i.name = groupName; i.checked = checked;
  i.addEventListener('change', () => { if (i.checked) save(); });
  const span = document.createElement('span'); span.textContent = label;
  r.append(i, span); container.appendChild(r);
}

function kdTextArea(container: HTMLElement, value: string, save: (v: string) => void, rows = 3): HTMLTextAreaElement {
  const t = document.createElement('textarea'); t.className = 'kd-input'; t.rows = rows;
  t.style.width = '100%'; t.style.boxSizing = 'border-box'; t.style.resize = 'vertical';
  t.value = value;
  const commit = () => { if (t.value !== value) save(t.value); };
  t.addEventListener('blur', commit);
  container.appendChild(t);
  return t;
}

/** A checkbox that sits INLINE within an existing row (e.g. "Bold"/"Italic"
 *  packed onto the same row as Text Size) — unlike kdCheckRow, which always
 *  creates its own full-width row. */
function kdInlineCheck(row: HTMLElement, label: string, checked: boolean, save: (v: boolean) => void): void {
  const wrap = document.createElement('label'); wrap.className = 'kd-check-row'; wrap.style.display = 'inline-flex';
  const i = document.createElement('input'); i.type = 'checkbox'; i.checked = checked;
  i.addEventListener('change', () => save(i.checked));
  const span = document.createElement('span'); span.textContent = label;
  wrap.append(i, span); row.appendChild(wrap);
}

function kdHelp(container: HTMLElement, text: string): void {
  const p = document.createElement('div'); p.className = 'kd-help'; p.textContent = text; container.appendChild(p);
}

function kdButtonRow(container: HTMLElement): HTMLElement {
  const r = document.createElement('div'); r.className = 'kd-btn-row'; container.appendChild(r); return r;
}

function kdButton(container: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'kd-btn'; b.textContent = label;
  b.addEventListener('click', onClick);
  container.appendChild(b);
  return b;
}

interface KdGridColumn {
  key: string;
  label: string;
  type: 'text' | 'checkbox' | 'select';
  options?: { value: string, label: string }[];
  readOnly?: (row: Record<string, unknown>) => boolean;
}

/** Only the symbol dialog's Fields grid needs this (8 mixed-type columns,
 *  real add/remove rows) — generic over columns/rows rather than
 *  hand-built once, since a table this shape is otherwise a lot of
 *  near-duplicate cell-building code to get right for 8 columns. */
function kdGrid(
  container: HTMLElement,
  columns: KdGridColumn[],
  rows: Record<string, unknown>[],
  handlers: {
    onCellChange: (rowIndex: number, key: string, value: string | boolean) => void;
    onAddRow?: () => void;
    onRemoveRow?: (rowIndex: number) => void;
    canRemoveRow?: (rowIndex: number) => boolean;
  }
): void {
  const wrap = document.createElement('div'); wrap.className = 'kd-grid-wrap';
  const table = document.createElement('table'); table.className = 'kd-grid';
  const thead = document.createElement('thead'); const headRow = document.createElement('tr');
  for (const col of columns) { const th = document.createElement('th'); th.textContent = col.label; headRow.appendChild(th); }
  if (handlers.onRemoveRow) { const th = document.createElement('th'); headRow.appendChild(th); }
  thead.appendChild(headRow); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const value = row[col.key];
      if (col.type === 'checkbox') {
        td.className = 'kd-grid-check';
        const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!value;
        i.addEventListener('change', () => handlers.onCellChange(rowIndex, col.key, i.checked));
        td.appendChild(i);
      }
      else if (col.type === 'select' && col.options) {
        const select = document.createElement('select'); select.className = 'kd-input';
        for (const o of col.options) { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; select.appendChild(opt); }
        select.value = col.options.some(o => o.value === value) ? String(value) : (col.options[0]?.value ?? '');
        select.addEventListener('change', () => handlers.onCellChange(rowIndex, col.key, select.value));
        td.appendChild(select);
      }
      else {
        const i = document.createElement('input'); i.className = 'kd-input'; i.value = String(value ?? '');
        if (col.readOnly?.(row)) { i.disabled = true; }
        const commit = () => handlers.onCellChange(rowIndex, col.key, i.value);
        i.addEventListener('change', commit);
        i.addEventListener('keydown', e => { if (e.key === 'Enter') { commit(); i.blur(); } });
        td.appendChild(i);
      }
      tr.appendChild(td);
    }
    if (handlers.onRemoveRow) {
      const td = document.createElement('td'); td.className = 'kd-grid-check';
      if (!handlers.canRemoveRow || handlers.canRemoveRow(rowIndex)) {
        kdButtonLikeCell(td, '✕', () => handlers.onRemoveRow!(rowIndex));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
  if (handlers.onAddRow) {
    const btnRow = kdButtonRow(container);
    kdButton(btnRow, '+ Add Field', handlers.onAddRow);
  }
}

function kdButtonLikeCell(td: HTMLElement, label: string, onClick: () => void): void {
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'kd-grid-row-del'; btn.textContent = label;
  btn.addEventListener('click', onClick);
  td.appendChild(btn);
}

/** Shared "commit an edit, refresh undo pane, leave the DOM alone" tail —
 *  every property-panel field handler ends with this. Not rebuilding the
 *  panel from inside its own event handler is deliberate: doing so would
 *  replace the focused input/checkbox before the browser finishes the
 *  interaction (e.g. losing focus mid-keystroke) — the next selection
 *  change reads the new live model instead. */
function makeSymbolMutator(id: string): (fn: (symbol: any) => void) => void {
  return (fn) => {
    const s = session;
    if (!s?.mutateSymbolByPaintId(id, fn)) return;
    lastFullSch = s.getSchematicText() || lastFullSch;
    updateUndoStackPane();
  };
}

/** Same contract as makeSymbolMutator, for every non-symbol element kind. */
function makeElementMutator(id: string): (fn: (element: any) => void) => void {
  return (fn) => {
    const s = session;
    if (!s?.mutateElementByPaintId(id, fn)) return;
    lastFullSch = s.getSchematicText() || lastFullSch;
    updateUndoStackPane();
  };
}

/** Batch counterpart to makeElementMutator, for renderMultiProperties — one
 *  commit/undo entry for the whole selection (via
 *  session.mutateElementsByPaintIds) instead of one per item. */
function makeElementsMutator(ids: string[]): (fn: (element: any) => void) => void {
  return (fn) => {
    const s = session;
    const count = s?.mutateElementsByPaintIds(ids, fn) ?? 0;
    if (count === 0) return;
    lastFullSch = s!.getSchematicText() || lastFullSch;
    updateUndoStackPane();
  };
}

const LINE_STYLE_OPTIONS = [
  { value: 'default', label: 'Default' }, { value: 'solid', label: 'Solid' }, { value: 'dash', label: 'Dashed' },
  { value: 'dot', label: 'Dotted' }, { value: 'dash_dot', label: 'Dash-Dot' }, { value: 'dash_dot_dot', label: 'Dash-Dot-Dot' },
];

const FILL_TYPE_OPTIONS = [
  { value: 'none', label: 'None' }, { value: 'color', label: 'Custom Color' },
  { value: 'outline', label: 'Same As Border' }, { value: 'background', label: 'Body Background' },
];

function renderSymbolProperties(symbol: any, kind: string, id: string): void {
  propertyTargetEl.innerHTML = '';
  const mutate = makeSymbolMutator(id);
  // Pin number/name visibility + offset are library-symbol-only fields in
  // real KiCad (see mutateLibSymbolForInstance's doc comment) — read AND
  // write target the resolved library definition, not this instance,
  // otherwise the checkbox shows a value the renderer never actually
  // consults and toggling it has no visible effect.
  const libDef = session?.findLibSymbolForInstance(id) ?? null;
  const mutateLibDef = (fn: (current: any) => void) => {
    const s = session;
    if (!s?.mutateLibSymbolForInstance(id, fn)) return;
    lastFullSch = s.getSchematicText() || lastFullSch;
    updateUndoStackPane();
  };
  const origin = symbol.getOrigin?.();
  const basic = propertySection('Basic Properties');
  propertyCheckRow(basic, 'Pin numbers', !libDef?.arePinNumbersHidden?.(), v => mutateLibDef(current => current.togglePinNumbers(v)));
  propertyCheckRow(basic, 'Pin names', !libDef?.arePinNameLabelsHidden?.(), v => mutateLibDef(current => current.togglePinNames(v)));
  propertyRow(basic, 'Position X (mm)', origin ? origin.x.toFixed(2) : '—', !!origin, v => { if (origin) mutate(current => { const live = current.getOrigin(); current.setOrigin(Number(v) || 0, live.y, live.rotation ?? 0); }); });
  propertyRow(basic, 'Position Y (mm)', origin ? origin.y.toFixed(2) : '—', !!origin, v => { if (origin) mutate(current => { const live = current.getOrigin(); current.setOrigin(live.x, Number(v) || 0, live.rotation ?? 0); }); });
  if (origin) { const rotation = ((Math.round(Number(origin.rotation ?? 0) / 90) * 90) % 360 + 360) % 360; propertyOrientationRow(basic, 'Orientation', String(rotation), ['0', '90', '180', '270'], v => mutate(current => { const live = current.getOrigin(); current.setOrigin(live.x, live.y, Number(v)); })); }
  propertyRow(basic, 'Object', `${kind} (${id.slice(0, 8)})`);
  const fields = propertySection('Fields');
  for (const p of symbol.getProperties?.() ?? []) { const n = String(p.propertyName ?? ''); if (n) propertyRow(fields, n, String(p.propertyValue ?? ''), true, v => mutate(current => current.setProperty(n, v))); }
  const attrs = propertySection('Attributes');
  propertyCheckRow(attrs, 'Exclude From Simulation', !!symbol.findFirstChildByName?.('exclude_from_sim')?.value, v => mutate(current => current.setExcludeFromSim(v)));
  propertyCheckRow(attrs, 'Do Not Populate', !!symbol.isDnp?.(), v => mutate(current => current.setDnp(v)));
  propertyCheckRow(attrs, 'Exclude From BOM', symbol.findFirstChildByName?.('in_bom')?.value === false, v => mutate(current => current.setInBom(!v)));
  propertyCheckRow(attrs, 'Exclude From Board', symbol.findFirstChildByName?.('on_board')?.value === false, v => mutate(current => current.setOnBoard(!v)));
  propertyCheckRow(attrs, 'Exclude From Position Files', symbol.findFirstChildByName?.('in_pos_files')?.value === false, v => mutate(current => current.setInPosFiles(!v)));
  const pin = propertySection('Pin Display');
  propertyCheckRow(pin, 'Show Pin Number', !libDef?.arePinNumbersHidden?.(), v => mutateLibDef(current => current.togglePinNumbers(v)));
  propertyCheckRow(pin, 'Show Pin Name', !libDef?.arePinNameLabelsHidden?.(), v => mutateLibDef(current => current.togglePinNames(v)));
  const pinNames = (libDef as any)?.findFirstChildByName?.('pin_names');
  propertyRow(pin, 'Pin Name Offset (mm)', Number(pinNames?.getOffset?.() ?? 0).toFixed(2), true, v => mutateLibDef(current => current.setPinNameOffset(Number(v) || 0)));
}

/** Graphic shapes: line/rectangle/circle/arc/polygon/bezier, plus rule
 *  areas (a wrapper around a nested polyline that actually carries the
 *  stroke/fill — see KicadElementRuleArea's doc comment; DNP/exclude flags
 *  live on the wrapper itself, everything else targets the nested
 *  polyline). Border width/style/color + fill type/color mirror real
 *  KiCad's DIALOG_SHAPE_PROPERTIES (eeschema/dialogs/dialog_shape_
 *  properties.cpp) — one dialog class for every shape type there too. */
function renderShapeProperties(element: any, kind: string, id: string): void {
  propertyTargetEl.innerHTML = '';
  const mutate = makeElementMutator(id);
  const isRuleArea = typeof element.getPolyline === 'function';
  const strokeTarget = isRuleArea ? element.getPolyline() : element;
  // mutate() re-looks-up the element fresh by paint id on every call (never
  // reuses the `element`/`strokeTarget` closed-over references past this
  // render) — this resolves the SAME nested-polyline indirection on the
  // freshly-found instance, mirroring strokeTarget above exactly.
  const freshTarget = (current: any) => (isRuleArea ? current.getPolyline() : current);

  const basic = propertySection('Basic Properties');
  propertyRow(basic, 'Object', `${kind === 'symbol-graphic' ? (element.name ?? 'shape') : kind} (${id.slice(0, 8)})`);

  if (strokeTarget && typeof strokeTarget.getStroke === 'function') {
    const border = propertySection('Border');
    const stroke = strokeTarget.getStroke();
    propertyRow(border, 'Width (mm)', stroke.width.toFixed(2), true, v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => { const t = freshTarget(current); t.setStroke(n, t.getStroke().type); });
    });
    propertySelectRow(border, 'Style', stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => { const t = freshTarget(current); t.setStroke(t.getStroke().width, v); }));
    propertyColorRow(border, 'Color', strokeTarget.getStrokeColorOverride?.(), hex => mutate(current => freshTarget(current).setStrokeColor(...hexToRgb255(hex))));
  }

  // Bezier composes WithFill at the data level (round-trips a stored fill
  // losslessly) but the renderer never draws one filled (buildSchBezier
  // hardcodes shape.filled:false, unlike every other shape type) — showing
  // fill controls here would be a control that silently does nothing
  // visually, so it's deliberately excluded.
  if (strokeTarget && typeof strokeTarget.getFill === 'function' && strokeTarget.name !== 'bezier') {
    const fill = propertySection('Fill');
    const fillType = strokeTarget.getFill();
    propertySelectRow(fill, 'Type', fillType, FILL_TYPE_OPTIONS, v => mutate(current => freshTarget(current).setFill(v)));
    propertyColorRow(fill, 'Color', strokeTarget.getFillColorOverride?.(), hex => mutate(current => freshTarget(current).setFillColor(...hexToRgb255(hex))));
  }

  if (isRuleArea) {
    const ruleArea = propertySection('Rule Area');
    propertyCheckRow(ruleArea, 'Do Not Populate', !!element.isDnp?.(), v => mutate(current => current.setDnp(v)));
    propertyCheckRow(ruleArea, 'Exclude From Simulation', !!element.isExcludedFromSim?.(), v => mutate(current => current.setExcludedFromSim(v)));
    propertyCheckRow(ruleArea, 'Exclude From BOM', !element.isInBom?.(), v => mutate(current => current.setInBom(!v)));
    propertyCheckRow(ruleArea, 'Exclude From Board', !element.isOnBoard?.(), v => mutate(current => current.setOnBoard(!v)));
  }
}

/** Wire/bus/bus-entry (all share kind:'wire' except plain buses, kind:'bus')
 *  — width/style/color, mirrors real KiCad's DIALOG_WIRE_BUS_PROPERTIES
 *  (eeschema/dialogs/dialog_wire_bus_properties.cpp). No fill (these are
 *  pure lines, not closed shapes). */
function renderWireBusProperties(element: any, kind: string, id: string): void {
  propertyTargetEl.innerHTML = '';
  const mutate = makeElementMutator(id);
  const basic = propertySection('Basic Properties');
  propertyRow(basic, 'Object', `${kind === 'bus' ? 'Bus' : (typeof element.getSize === 'function' ? 'Bus Entry' : 'Wire')} (${id.slice(0, 8)})`);

  const line = propertySection('Line');
  const stroke = element.getStroke();
  propertyRow(line, 'Width (mm)', stroke.width.toFixed(2), true, v => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) mutate(current => current.setStroke(n, current.getStroke().type));
  });
  propertySelectRow(line, 'Style', stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => current.setStroke(current.getStroke().width, v)));
  propertyColorRow(line, 'Color', element.getStrokeColorOverride?.(), hex => mutate(current => current.setStrokeColor(...hexToRgb255(hex))));
}

/** Mirrors real KiCad's DIALOG_JUNCTION_PROPS (eeschema/dialogs/
 *  dialog_junction_props.cpp) — diameter + color only, no line style (a
 *  junction is a filled dot, not a stroked shape). */
function renderJunctionProperties(junction: any, id: string): void {
  propertyTargetEl.innerHTML = '';
  const mutate = makeElementMutator(id);
  const basic = propertySection('Basic Properties');
  propertyRow(basic, 'Object', `Junction (${id.slice(0, 8)})`);
  const props = propertySection('Junction');
  propertyRow(props, 'Diameter (mm)', junction.getDiameter().toFixed(2), true, v => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) mutate(current => current.setDiameter(n));
  });
  propertyColorRow(props, 'Color', junction.getColorOverride?.(), hex => mutate(current => current.setColor(...hexToRgb255(hex))));
}

/** Standalone text and text boxes — mirrors real KiCad's
 *  DIALOG_TEXT_PROPERTIES (eeschema/dialogs/dialog_text_properties.cpp):
 *  content, size, bold/italic, color; a text box additionally gets its own
 *  border/fill (identical shape to renderShapeProperties' Border/Fill
 *  sections — real KiCad's dialog literally shows the same border/fill
 *  controls for a text box as for any other closed shape). Hyperlink and
 *  per-unit "common to all units" (symbol-editor only) are out of scope —
 *  neither applies to a plain schematic-root text item. */
function renderTextProperties(element: any, id: string): void {
  propertyTargetEl.innerHTML = '';
  const mutate = makeElementMutator(id);
  const isTextBox = element.name === 'text_box';
  const basic = propertySection('Basic Properties');
  propertyRow(basic, 'Object', `${isTextBox ? 'Text Box' : 'Text'} (${id.slice(0, 8)})`);
  propertyRow(basic, 'Text', String(element.value ?? ''), true, v => mutate(current => { current.value = v; }));

  const font = propertySection('Font');
  const fontInfo = typeof element.getFont === 'function' ? element.getFont() : { width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
  propertyRow(font, 'Size (mm)', (fontInfo.height || 1.27).toFixed(2), true, v => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) mutate(current => { const f = current.getFont(); current.setFont(n, n, f.italic, f.bold, f.thickness); });
  });
  propertyCheckRow(font, 'Bold', !!fontInfo.bold, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, f.italic, v, f.thickness); }));
  propertyCheckRow(font, 'Italic', !!fontInfo.italic, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, v, f.bold, f.thickness); }));
  propertyColorRow(font, 'Color', element.getFontColorOverride?.(), hex => mutate(current => current.setFontColor(...hexToRgb255(hex))));

  if (isTextBox) {
    const border = propertySection('Border');
    const stroke = element.getStroke();
    propertyRow(border, 'Width (mm)', stroke.width.toFixed(2), true, v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => current.setStroke(n, current.getStroke().type));
    });
    propertySelectRow(border, 'Style', stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => current.setStroke(current.getStroke().width, v)));
    propertyColorRow(border, 'Color', element.getStrokeColorOverride?.(), hex => mutate(current => current.setStrokeColor(...hexToRgb255(hex))));

    const fill = propertySection('Fill');
    propertySelectRow(fill, 'Type', element.getFill(), FILL_TYPE_OPTIONS, v => mutate(current => current.setFill(v)));
    propertyColorRow(fill, 'Color', element.getFillColorOverride?.(), hex => mutate(current => current.setFillColor(...hexToRgb255(hex))));
  }
}

const GLOBAL_HIER_SHAPE_OPTIONS = [
  { value: 'input', label: 'Input' }, { value: 'output', label: 'Output' },
  { value: 'bidirectional', label: 'Bidirectional' }, { value: 'tri_state', label: 'Tri-State' },
  { value: 'passive', label: 'Passive' },
];
const DIRECTIVE_SHAPE_OPTIONS = [
  { value: 'dot', label: 'Dot' }, { value: 'round', label: 'Circle' },
  { value: 'diamond', label: 'Diamond' }, { value: 'rectangle', label: 'Rectangle' },
];

/** Local/global/hierarchical/directive labels — mirrors real KiCad's
 *  DIALOG_LABEL_PROPERTIES (eeschema/dialogs/dialog_label_properties.cpp):
 *  text, shape (electrical direction for global/hier, glyph style for
 *  directive — none for local, which has no shape concept at all), pin
 *  length (directive only — real KiCad reuses its text-size field for this
 *  when editing a directive label, an odd but confirmed dual-purpose UI
 *  quirk; kept as its own separate row here instead since this app's font-
 *  size field already means something else), font size/bold/italic/color.
 *  Renaming/shape-cycling reuse the session's existing renameLabel/
 *  setLabelShape (already used by the right-click context menu's Edit
 *  Text…/Cycle Shape actions) rather than a raw mutate(), since those
 *  already handle each label kind's own storage quirk (e.g. directive
 *  labels keep their text in a "Netclass" property, not a top-level
 *  attribute — see KicadElementNetclassFlag's doc comment). */
function renderLabelProperties(element: any, labelKind: string | undefined, id: string): void {
  propertyTargetEl.innerHTML = '';
  const mutate = makeElementMutator(id);
  const kindLabel = labelKind === 'local' ? 'Local Label' : labelKind === 'global' ? 'Global Label'
    : labelKind === 'hier' ? 'Hierarchical Label' : labelKind === 'directive' ? 'Directive Label' : 'Label';
  const basic = propertySection('Basic Properties');
  propertyRow(basic, 'Object', `${kindLabel} (${id.slice(0, 8)})`);

  const currentName = typeof element.getName === 'function' ? element.getName() : String(element.value ?? '');
  propertyRow(basic, 'Text', currentName, true, v => {
    const s = session;
    if (!s?.renameLabel(id, v)) return;
    lastFullSch = s.getSchematicText() || lastFullSch;
    updateUndoStackPane();
  });

  if (labelKind === 'global' || labelKind === 'hier') {
    propertySelectRow(basic, 'Shape', element.getShape?.() ?? 'input', GLOBAL_HIER_SHAPE_OPTIONS, v => {
      const s = session;
      if (!s?.setLabelShape(id, v as KicadGlobalLabelShape)) return;
      lastFullSch = s.getSchematicText() || lastFullSch;
      updateUndoStackPane();
    });
  }
  else if (labelKind === 'directive') {
    propertySelectRow(basic, 'Shape', element.getShape?.() ?? 'round', DIRECTIVE_SHAPE_OPTIONS, v => {
      const s = session;
      if (!s?.setLabelShape(id, v as KicadDirectiveLabelShape)) return;
      lastFullSch = s.getSchematicText() || lastFullSch;
      updateUndoStackPane();
    });
    propertyRow(basic, 'Pin Length (mm)', Number(element.getPinLength?.() ?? 2.54).toFixed(2), true, v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => current.setPinLength(n));
    });
  }

  const font = propertySection('Font');
  const fontInfo = typeof element.getFont === 'function' ? element.getFont() : { width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
  propertyRow(font, 'Size (mm)', (fontInfo.height || 1.27).toFixed(2), true, v => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) mutate(current => { const f = current.getFont(); current.setFont(n, n, f.italic, f.bold, f.thickness); });
  });
  propertyCheckRow(font, 'Bold', !!fontInfo.bold, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, f.italic, v, f.thickness); }));
  propertyCheckRow(font, 'Italic', !!fontInfo.italic, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, v, f.bold, f.thickness); }));
  propertyColorRow(font, 'Color', element.getFontColorOverride?.(), hex => mutate(current => current.setFontColor(...hexToRgb255(hex))));
}

/** element.name values renderMultiProperties knows how to batch-edit — same
 *  scoping real KiCad's own SCH_EDIT_TOOL::Properties() uses (every selected
 *  item must be the SAME type before its multi-edit dialog even opens).
 *  Symbols and labels are deliberately absent: their one most-useful field
 *  (Reference, label text) is inherently per-instance, and a symbol's one
 *  otherwise-safe batchable field (pin number/name display) targets the
 *  resolved LIBRARY definition through mutateLibSymbolForInstance, a
 *  structurally different per-item target this generic paint-id mutator
 *  can't express. */
const MULTI_EDIT_NAMES = new Set([
  'wire', 'bus', 'bus_entry', 'junction',
  'rectangle', 'circle', 'arc', 'polyline', 'bezier', 'rule_area',
  'text', 'text_box',
]);

/** Multi-selection counterpart to the renderXProperties family above —
 *  updateEditSidebar() shows this instead of the plain "N objects selected"
 *  text when every selected item shares one element.name in
 *  MULTI_EDIT_NAMES. Branches explicitly by name (mirroring each single-
 *  item render function's own field set exactly) rather than by capability-
 *  sniffing across the whole union, so e.g. a wire selection can never
 *  accidentally pick up a Fill section meant for shapes. Every row's
 *  initially-displayed value comes from the FIRST selected element only —
 *  there is no "indeterminate/mixed" state — but editing a field always
 *  writes the new value to EVERY selected item via makeElementsMutator, so
 *  this only affects what's shown before the user changes anything, never
 *  correctness of the edit itself. */
function renderMultiProperties(name: string, elements: any[], ids: string[]): void {
  propertyTargetEl.innerHTML = '';
  const mutate = makeElementsMutator(ids);
  const first = elements[0];
  const basic = propertySection('Basic Properties');
  propertyRow(basic, 'Object', `${elements.length} × ${name}`);

  if (name === 'wire' || name === 'bus' || name === 'bus_entry') {
    const line = propertySection('Line');
    const stroke = first.getStroke();
    propertyRow(line, 'Width (mm)', stroke.width.toFixed(2), true, v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => current.setStroke(n, current.getStroke().type));
    });
    propertySelectRow(line, 'Style', stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => current.setStroke(current.getStroke().width, v)));
    propertyColorRow(line, 'Color', first.getStrokeColorOverride?.(), hex => mutate(current => current.setStrokeColor(...hexToRgb255(hex))));
    return;
  }

  if (name === 'junction') {
    const props = propertySection('Junction');
    propertyRow(props, 'Diameter (mm)', first.getDiameter().toFixed(2), true, v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => current.setDiameter(n));
    });
    propertyColorRow(props, 'Color', first.getColorOverride?.(), hex => mutate(current => current.setColor(...hexToRgb255(hex))));
    return;
  }

  if (name === 'text' || name === 'text_box') {
    const font = propertySection('Font');
    const fontInfo = typeof first.getFont === 'function' ? first.getFont() : { width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
    propertyRow(font, 'Size (mm)', (fontInfo.height || 1.27).toFixed(2), true, v => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) mutate(current => { const f = current.getFont(); current.setFont(n, n, f.italic, f.bold, f.thickness); });
    });
    propertyCheckRow(font, 'Bold', !!fontInfo.bold, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, f.italic, v, f.thickness); }));
    propertyCheckRow(font, 'Italic', !!fontInfo.italic, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, v, f.bold, f.thickness); }));
    propertyColorRow(font, 'Color', first.getFontColorOverride?.(), hex => mutate(current => current.setFontColor(...hexToRgb255(hex))));

    if (name === 'text_box') {
      const border = propertySection('Border');
      const stroke = first.getStroke();
      propertyRow(border, 'Width (mm)', stroke.width.toFixed(2), true, v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) mutate(current => current.setStroke(n, current.getStroke().type));
      });
      propertySelectRow(border, 'Style', stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => current.setStroke(current.getStroke().width, v)));
      propertyColorRow(border, 'Color', first.getStrokeColorOverride?.(), hex => mutate(current => current.setStrokeColor(...hexToRgb255(hex))));

      const fill = propertySection('Fill');
      propertySelectRow(fill, 'Type', first.getFill(), FILL_TYPE_OPTIONS, v => mutate(current => current.setFill(v)));
      propertyColorRow(fill, 'Color', first.getFillColorOverride?.(), hex => mutate(current => current.setFillColor(...hexToRgb255(hex))));
    }
    return;
  }

  // rectangle / circle / arc / polyline / bezier / rule_area
  const isRuleArea = name === 'rule_area';
  const strokeOf = (el: any) => (isRuleArea ? el.getPolyline() : el);
  const strokeTarget = strokeOf(first);
  if (strokeTarget && typeof strokeTarget.getStroke === 'function') {
    const border = propertySection('Border');
    const stroke = strokeTarget.getStroke();
    propertyRow(border, 'Width (mm)', stroke.width.toFixed(2), true, v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => { const t = strokeOf(current); t.setStroke(n, t.getStroke().type); });
    });
    propertySelectRow(border, 'Style', stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => { const t = strokeOf(current); t.setStroke(t.getStroke().width, v); }));
    propertyColorRow(border, 'Color', strokeTarget.getStrokeColorOverride?.(), hex => mutate(current => strokeOf(current).setStrokeColor(...hexToRgb255(hex))));
  }
  if (name !== 'bezier' && strokeTarget && typeof strokeTarget.getFill === 'function') {
    const fill = propertySection('Fill');
    const fillType = strokeTarget.getFill();
    propertySelectRow(fill, 'Type', fillType, FILL_TYPE_OPTIONS, v => mutate(current => strokeOf(current).setFill(v)));
    propertyColorRow(fill, 'Color', strokeTarget.getFillColorOverride?.(), hex => mutate(current => strokeOf(current).setFillColor(...hexToRgb255(hex))));
  }
  if (isRuleArea) {
    const ruleArea = propertySection('Rule Area');
    propertyCheckRow(ruleArea, 'Do Not Populate', !!first.isDnp?.(), v => mutate(current => current.setDnp(v)));
    propertyCheckRow(ruleArea, 'Exclude From Simulation', !!first.isExcludedFromSim?.(), v => mutate(current => current.setExcludedFromSim(v)));
    propertyCheckRow(ruleArea, 'Exclude From BOM', !first.isInBom?.(), v => mutate(current => current.setInBom(!v)));
    propertyCheckRow(ruleArea, 'Exclude From Board', !first.isOnBoard?.(), v => mutate(current => current.setOnBoard(!v)));
  }
}

// ---- Double-click properties dialogs (native-KiCad-dialog style) ----
// Separate from the renderXProperties family above (which the sidebar still
// uses, unchanged) — these target an explicit container via the kd* helpers
// rather than the module-level propertyTargetEl, and lay out fields to match
// each real KiCad dialog's own structure (see the research this was built
// from: eeschema/dialogs/dialog_*_base.fbp in the user's local checkout),
// not just the sidebar's compact stacked-row list.

/** Mirrors DIALOG_JUNCTION_PROPS exactly: Diameter row, Color row, 2 help
 *  lines, a "Default" button (real KiCad relabels its Apply button to this —
 *  resets diameter to 0 / color to unspecified, both meaning "use the
 *  schematic's own defaults"). */
function renderJunctionDialog(junction: any, id: string): void {
  propertiesModalTitleEl.textContent = 'Junction Properties';
  const body = propertiesModalBodyEl;
  const mutate = makeElementMutator(id);

  const diaRow = kdRow(body);
  kdLabel(diaRow, 'Diameter:');
  kdTextInput(diaRow, junction.getDiameter().toFixed(2), v => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) mutate(current => current.setDiameter(n));
  }, true);
  kdUnit(diaRow, 'mm');

  const colorRow = kdRow(body);
  kdLabel(colorRow, 'Color:');
  kdSwatch(colorRow, junction.getColorOverride?.(), hex => mutate(current => current.setColor(...hexToRgb255(hex))));

  kdHelp(body, "Set diameter to 0 to use schematic's junction dot size.");
  kdHelp(body, 'Clear color to use Schematic Editor colors.');

  const btnRow = kdButtonRow(body);
  kdButton(btnRow, 'Default', () => {
    mutate(current => { current.setDiameter(0); current.setColor(0, 0, 0, 0); });
    showPropertiesModal(id);
  });
}

/** Mirrors DIALOG_WIRE_BUS_PROPERTIES: Width+Color on one row, Style on its
 *  own row, 2 help lines, a "Default" button (resets width->0, color-
 *  >unspecified, style->'default'). Real KiCad's dialog also has a Junction
 *  Size field for multi-selections that include a junction — this app's
 *  modal always targets exactly one element (junctions get their own
 *  dedicated dialog above), so that field doesn't apply here. */
function renderWireBusDialog(element: any, kind: string, id: string): void {
  const isBusEntry = typeof element.getSize === 'function';
  const label = kind === 'bus' ? 'Bus' : (isBusEntry ? 'Bus Entry' : 'Wire');
  propertiesModalTitleEl.textContent = `${label} Properties`;
  const body = propertiesModalBodyEl;
  const mutate = makeElementMutator(id);
  const stroke = element.getStroke();

  const widthRow = kdRow(body);
  kdLabel(widthRow, `${label} width:`);
  kdTextInput(widthRow, stroke.width.toFixed(2), v => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) mutate(current => current.setStroke(n, current.getStroke().type));
  }, true);
  kdUnit(widthRow, 'mm');
  kdLabel(widthRow, 'Color:');
  kdSwatch(widthRow, element.getStrokeColorOverride?.(), hex => mutate(current => current.setStrokeColor(...hexToRgb255(hex))));

  const styleRow = kdRow(body);
  kdLabel(styleRow, 'Style:');
  kdSelect(styleRow, stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => current.setStroke(current.getStroke().width, v)));

  kdHelp(body, "Set width to 0 to use netclass's wire/bus widths.");
  kdHelp(body, 'Clear color to use Schematic Editor colors.');

  const btnRow = kdButtonRow(body);
  kdButton(btnRow, 'Default', () => {
    mutate(current => { current.setStroke(0, 'default'); current.setStrokeColor(0, 0, 0, 0); });
    showPropertiesModal(id);
  });
}

const SHAPE_TITLES: Record<string, string> = {
  rectangle: 'Rectangle', circle: 'Circle', arc: 'Arc', polyline: 'Polyline', bezier: 'Bezier',
};

/** Mirrors DIALOG_SHAPE_PROPERTIES (schematic-editor variant, not the Symbol
 *  Editor's — this app has no symbol editor, so the Fill Style radio-button
 *  page and the "Private to Symbol Editor"/"Common to all units" row are
 *  both omitted, not just disabled, matching this pass's "omit what this
 *  app doesn't model" precedent): Rule-Area-only checkboxes (own block,
 *  shown only for a rule area), then Border | Fill side by side. Fill's
 *  options (none/color/outline/background) are kept exactly as the
 *  already-source-verified FILL_TYPE_OPTIONS — NOT the solid/hatch/cross-
 *  hatch vocabulary a fresh dialog-layout pass surfaced, which reads like a
 *  different (PCB-graphic) fill concept and would contradict the file-
 *  format semantics already verified in an earlier arc; trusting prior,
 *  independently-confirmed code over one unverified research pass here. */
function renderShapeDialog(element: any, kind: string, id: string): void {
  const isRuleArea = typeof element.getPolyline === 'function';
  const strokeTarget = isRuleArea ? element.getPolyline() : element;
  const freshTarget = (current: any) => (isRuleArea ? current.getPolyline() : current);
  const shapeName = kind === 'symbol-graphic' ? (element.name ?? 'shape') : kind;
  propertiesModalTitleEl.textContent = `${isRuleArea ? 'Rule Area' : (SHAPE_TITLES[shapeName] ?? 'Shape')} Properties`;
  const body = propertiesModalBodyEl;
  const mutate = makeElementMutator(id);

  if (isRuleArea) {
    kdCheckRow(body, 'Exclude from simulation', !!element.isExcludedFromSim?.(), v => mutate(current => current.setExcludedFromSim(v)));
    kdCheckRow(body, 'Exclude from board', !element.isOnBoard?.(), v => mutate(current => current.setOnBoard(!v)));
    kdCheckRow(body, 'Do not populate', !!element.isDnp?.(), v => mutate(current => current.setDnp(v)));
    kdCheckRow(body, 'Exclude from bill of materials', !element.isInBom?.(), v => mutate(current => current.setInBom(!v)));
  }

  const [borderCol, fillCol] = kdColumns(body);

  if (strokeTarget && typeof strokeTarget.getStroke === 'function') {
    const border = kdSection(borderCol, 'Border');
    const stroke = strokeTarget.getStroke();
    const widthRow = kdRow(border);
    kdLabel(widthRow, 'Width:');
    kdTextInput(widthRow, stroke.width.toFixed(2), v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => { const t = freshTarget(current); t.setStroke(n, t.getStroke().type); });
    }, true);
    kdUnit(widthRow, 'mm');
    kdLabel(widthRow, 'Color:');
    kdSwatch(widthRow, strokeTarget.getStrokeColorOverride?.(), hex => mutate(current => freshTarget(current).setStrokeColor(...hexToRgb255(hex))));
    const styleRow = kdRow(border);
    kdLabel(styleRow, 'Style:');
    kdSelect(styleRow, stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => { const t = freshTarget(current); t.setStroke(t.getStroke().width, v); }));
    kdHelp(border, "Set border width to 0 to use schematic's default line width.");
  }

  if (strokeTarget && typeof strokeTarget.getFill === 'function' && strokeTarget.name !== 'bezier') {
    const fill = kdSection(fillCol, 'Fill');
    const fillRow = kdRow(fill);
    kdLabel(fillRow, 'Fill:');
    kdSelect(fillRow, strokeTarget.getFill(), FILL_TYPE_OPTIONS, v => mutate(current => freshTarget(current).setFill(v)));
    const fillColorRow = kdRow(fill);
    kdLabel(fillColorRow, 'Fill color:');
    kdSwatch(fillColorRow, strokeTarget.getFillColorOverride?.(), hex => mutate(current => freshTarget(current).setFillColor(...hexToRgb255(hex))));
    kdHelp(fill, 'Clear colors to use Schematic Editor colors.');
  }
}

/** Mirrors DIALOG_TEXT_PROPERTIES: multi-line content, Font size + Bold/
 *  Italic + Color row, then (text box only) Border | Fill side by side —
 *  same Border/Fill fields and vocabulary as renderShapeDialog, since a
 *  text box's fill is the same underlying WithFill data as any other closed
 *  shape (see that dialog's own doc comment for why the fill vocabulary is
 *  kept as FILL_TYPE_OPTIONS, not the report's "Background fill" checkbox
 *  wording). Omitted vs. the real dialog: font-family dropdown (this app
 *  only has one stroke font, a FONT_CHOICE controlled would have exactly
 *  one meaningful option), hyperlink, syntax-help hyperlink, exclude-from-
 *  simulation (not modeled on text elements at all — WithEffects/
 *  KicadElementTextBase has no such field), symbol-editor-only rows (no
 *  symbol editor in this app), and H/V alignment + horizontal/vertical text
 *  toggle (not exposed even in the old sidebar version — a real but
 *  separate gap from this pass's visual-restyle scope, not fixed here). */
function renderTextDialog(element: any, id: string): void {
  const isTextBox = element.name === 'text_box';
  propertiesModalTitleEl.textContent = isTextBox ? 'Text Box Properties' : 'Text Properties';
  const body = propertiesModalBodyEl;
  const mutate = makeElementMutator(id);

  kdTextArea(body, String(element.value ?? ''), v => mutate(current => { current.value = v; }), isTextBox ? 4 : 3);

  const fontInfo = typeof element.getFont === 'function' ? element.getFont() : { width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
  const fontRow = kdRow(body);
  kdLabel(fontRow, 'Text size:');
  kdTextInput(fontRow, (fontInfo.height || 1.27).toFixed(2), v => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) mutate(current => { const f = current.getFont(); current.setFont(n, n, f.italic, f.bold, f.thickness); });
  }, true);
  kdUnit(fontRow, 'mm');
  kdInlineCheck(fontRow, 'Bold', !!fontInfo.bold, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, f.italic, v, f.thickness); }));
  kdInlineCheck(fontRow, 'Italic', !!fontInfo.italic, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, v, f.bold, f.thickness); }));
  kdLabel(fontRow, 'Color:');
  kdSwatch(fontRow, element.getFontColorOverride?.(), hex => mutate(current => current.setFontColor(...hexToRgb255(hex))));

  if (isTextBox) {
    const [borderCol, fillCol] = kdColumns(body);
    const border = kdSection(borderCol, 'Border');
    const stroke = element.getStroke();
    const widthRow = kdRow(border);
    kdLabel(widthRow, 'Width:');
    kdTextInput(widthRow, stroke.width.toFixed(2), v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => current.setStroke(n, current.getStroke().type));
    }, true);
    kdUnit(widthRow, 'mm');
    kdLabel(widthRow, 'Color:');
    kdSwatch(widthRow, element.getStrokeColorOverride?.(), hex => mutate(current => current.setStrokeColor(...hexToRgb255(hex))));
    const styleRow = kdRow(border);
    kdLabel(styleRow, 'Style:');
    kdSelect(styleRow, stroke.type, LINE_STYLE_OPTIONS, v => mutate(current => current.setStroke(current.getStroke().width, v)));

    const fill = kdSection(fillCol, 'Fill');
    const fillRow = kdRow(fill);
    kdLabel(fillRow, 'Fill:');
    kdSelect(fillRow, element.getFill(), FILL_TYPE_OPTIONS, v => mutate(current => current.setFill(v)));
    const fillColorRow = kdRow(fill);
    kdLabel(fillColorRow, 'Fill color:');
    kdSwatch(fillColorRow, element.getFillColorOverride?.(), hex => mutate(current => current.setFillColor(...hexToRgb255(hex))));
  }
}

const LABEL_DIALOG_TITLES: Record<string, string> = {
  local: 'Label Properties', global: 'Global Label Properties',
  hier: 'Hierarchical Label Properties', directive: 'Directive Label Properties',
};

/** Mirrors DIALOG_LABEL_PROPERTIES's per-type conditional layout: text row
 *  (hidden for directive, which has no free text), Shape box (radio
 *  buttons — input/output/bidirectional/tri_state/passive for global/hier,
 *  dot/circle/diamond/rectangle for directive, whole box hidden for local),
 *  Formatting box (size/bold/italic/color — "Pin length" replaces size,
 *  and bold/italic are hidden, for directive). Sheet pins never reach this
 *  dialog (updateEditSidebar's dispatch has no sheet-pin case, matching
 *  real KiCad's own dialog constructor which — per source — never
 *  specifically branches its FIELD visibility for that type either).
 *
 *  Deliberately still missing vs. the real dialog: the Fields grid. Real
 *  KiCad shows one for every label type (it's literally how a directive
 *  label's Netclass/Component Class values are stored — KicadElementNetclass
 *  Flag does mix in WithProperties), but local/global/hier labels have NO
 *  WithProperties at all in this app's kicad-io layer, and the old sidebar
 *  version never exposed field editing for directive labels either — adding
 *  general field management is a real, separate feature, not a restyle. */
function renderLabelDialog(element: any, labelKind: string | undefined, id: string): void {
  propertiesModalTitleEl.textContent = LABEL_DIALOG_TITLES[labelKind ?? ''] ?? 'Label Properties';
  const body = propertiesModalBodyEl;
  const mutate = makeElementMutator(id);
  const isDirective = labelKind === 'directive';
  const hasShape = labelKind === 'global' || labelKind === 'hier' || isDirective;

  if (!isDirective) {
    const textRow = kdRow(body);
    kdLabel(textRow, 'Label:');
    const currentName = typeof element.getName === 'function' ? element.getName() : String(element.value ?? '');
    kdTextInput(textRow, currentName, v => {
      const s = session;
      if (!s?.renameLabel(id, v)) return;
      lastFullSch = s.getSchematicText() || lastFullSch;
      updateUndoStackPane();
    });
  }

  if (hasShape) {
    const [shapeCol, formatCol] = kdColumns(body);
    const shapeSection = kdSection(shapeCol, 'Shape');
    const currentShape = element.getShape?.() ?? (isDirective ? 'round' : 'input');
    const shapeOptions = isDirective ? DIRECTIVE_SHAPE_OPTIONS : GLOBAL_HIER_SHAPE_OPTIONS;
    for (const opt of shapeOptions) {
      kdRadioRow(shapeSection, `label-shape-${id}`, opt.label, currentShape === opt.value, () => {
        const s = session;
        if (!s?.setLabelShape(id, opt.value as KicadGlobalLabelShape | KicadDirectiveLabelShape)) return;
        lastFullSch = s.getSchematicText() || lastFullSch;
        updateUndoStackPane();
      });
    }
    renderLabelFormattingSection(formatCol, element, id, isDirective, mutate);
  }
  else {
    renderLabelFormattingSection(body, element, id, isDirective, mutate);
  }
}

function renderLabelFormattingSection(container: HTMLElement, element: any, id: string, isDirective: boolean, mutate: (fn: (element: any) => void) => void): void {
  const formatting = kdSection(container, 'Formatting');
  if (isDirective) {
    const lengthRow = kdRow(formatting);
    kdLabel(lengthRow, 'Pin length:');
    kdTextInput(lengthRow, Number(element.getPinLength?.() ?? 2.54).toFixed(2), v => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) mutate(current => current.setPinLength(n));
    }, true);
    kdUnit(lengthRow, 'mm');
    return;
  }
  const fontInfo = typeof element.getFont === 'function' ? element.getFont() : { width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
  const sizeRow = kdRow(formatting);
  kdLabel(sizeRow, 'Text size:');
  kdTextInput(sizeRow, (fontInfo.height || 1.27).toFixed(2), v => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) mutate(current => { const f = current.getFont(); current.setFont(n, n, f.italic, f.bold, f.thickness); });
  }, true);
  kdUnit(sizeRow, 'mm');
  kdInlineCheck(sizeRow, 'Bold', !!fontInfo.bold, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, f.italic, v, f.thickness); }));
  kdInlineCheck(sizeRow, 'Italic', !!fontInfo.italic, v => mutate(current => { const f = current.getFont(); current.setFont(f.width || 1.27, f.height || 1.27, v, f.bold, f.thickness); }));
  const colorRow = kdRow(formatting);
  kdLabel(colorRow, 'Color:');
  kdSwatch(colorRow, element.getFontColorOverride?.(), hex => mutate(current => current.setFontColor(...hexToRgb255(hex))));
}

const H_ALIGN_OPTIONS = [{ value: 'left', label: 'Left' }, { value: 'middle', label: 'Center' }, { value: 'right', label: 'Right' }];
const V_ALIGN_OPTIONS = [{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Center' }, { value: 'bottom', label: 'Bottom' }];

/** Mirrors DIALOG_SYMBOL_PROPERTIES's "General" tab — the only tab built,
 *  since the other 3 (Pin Functions: alternate pin electrical assignments;
 *  Pin Map: multi-unit alternate pin swapping; Embedded Files) all need
 *  data concepts this app doesn't model on a placed symbol instance at all,
 *  so a tab strip with 3 permanently-empty tabs would be worse than no
 *  tabs. Same reasoning for what's inside "General" itself: Unit/Body
 *  style/Mirror dropdowns are omitted (no multi-unit/multi-body-style/
 *  mirror concept in this app's kicad-io layer for symbol instances — the
 *  old sidebar never had them either), and the 5 right-side action buttons
 *  (Update/Change/Edit Symbol, Edit Library Symbol, Simulation Model) are
 *  omitted per explicit direction — nothing in this app to wire them to.
 *  Position X/Y is kept despite not being in the real dialog (real KiCad
 *  repositions purely by canvas drag/arrow-keys) — dropping a working,
 *  already-useful field to match the real dialog exactly would be a
 *  regression, not a restyle, so it's folded into General as a deliberate,
 *  documented departure rather than silently kept from the old layout. */
function renderSymbolDialog(symbol: any, id: string): void {
  propertiesModalTitleEl.textContent = 'Symbol Properties';
  const body = propertiesModalBodyEl;
  const mutate = makeSymbolMutator(id);
  const libDef = session?.findLibSymbolForInstance(id) ?? null;
  const mutateLibDef = (fn: (current: any) => void) => {
    const s = session;
    if (!s?.mutateLibSymbolForInstance(id, fn)) return;
    lastFullSch = s.getSchematicText() || lastFullSch;
    updateUndoStackPane();
  };

  const fields = kdSection(body, 'Fields');
  const properties = symbol.getProperties?.() ?? [];
  const MANDATORY = new Set(['Reference', 'Value', 'Footprint', 'Datasheet']);
  const gridRows = properties.map((p: any) => {
    const justify = p.getJustify?.() ?? { horizontal: 'left', vertical: 'top' };
    const font = p.getFont?.() ?? { bold: false, italic: false };
    return {
      Name: p.propertyName ?? '', Value: p.propertyValue ?? '',
      Show: !p.isHidden?.(), ShowName: !!p.getShowName?.(),
      HAlign: justify.horizontal, VAlign: justify.vertical,
      Italic: !!font.italic, Bold: !!font.bold,
    };
  });
  kdGrid(fields, [
    { key: 'Name', label: 'Name', type: 'text', readOnly: (row) => MANDATORY.has(String(row.Name)) },
    { key: 'Value', label: 'Value', type: 'text' },
    { key: 'Show', label: 'Show', type: 'checkbox' },
    { key: 'ShowName', label: 'Show Name', type: 'checkbox' },
    { key: 'HAlign', label: 'H Align', type: 'select', options: H_ALIGN_OPTIONS },
    { key: 'VAlign', label: 'V Align', type: 'select', options: V_ALIGN_OPTIONS },
    { key: 'Italic', label: 'Italic', type: 'checkbox' },
    { key: 'Bold', label: 'Bold', type: 'checkbox' },
  ], gridRows, {
    onCellChange: (rowIndex, key, value) => mutate(current => {
      const prop = current.getProperties?.()?.[rowIndex];
      if (!prop) return;
      switch (key) {
        case 'Name': prop.propertyName = String(value); break;
        case 'Value': prop.propertyValue = String(value); break;
        case 'Show': prop.setHidden?.(!value); break;
        case 'ShowName': prop.setShowName?.(!!value); break;
        case 'HAlign': prop.setJustify?.(value as any, prop.getJustify?.().vertical); break;
        case 'VAlign': prop.setJustify?.(prop.getJustify?.().horizontal, value as any); break;
        case 'Italic': { const f = prop.getFont?.() ?? {}; prop.setFont?.(f.width || 1.27, f.height || 1.27, !!value, f.bold, f.thickness); break; }
        case 'Bold': { const f = prop.getFont?.() ?? {}; prop.setFont?.(f.width || 1.27, f.height || 1.27, f.italic, !!value, f.thickness); break; }
      }
    }),
    onAddRow: () => {
      mutate(current => current.setProperty?.(`Field${(current.getProperties?.()?.length ?? 0) + 1}`, ''));
      showPropertiesModal(id);
    },
    onRemoveRow: (rowIndex) => {
      mutate(current => { const p = current.getProperties?.()?.[rowIndex]; if (p) current.deleteProperty?.(p.propertyName); });
      showPropertiesModal(id);
    },
    canRemoveRow: (rowIndex) => !MANDATORY.has(String(gridRows[rowIndex]?.Name)),
  });

  const [generalCol, attrCol] = kdColumns(body);
  const general = kdSection(generalCol, 'General');
  const origin = symbol.getOrigin?.();
  if (origin) {
    const rotation = ((Math.round(Number(origin.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
    const angleRow = kdRow(general);
    kdLabel(angleRow, 'Angle:');
    kdSelect(angleRow, String(rotation), ['0', '90', '180', '270'].map(v => ({ value: v, label: `${v}°` })),
      v => mutate(current => { const live = current.getOrigin(); current.setOrigin(live.x, live.y, Number(v)); }));
    const xRow = kdRow(general);
    kdLabel(xRow, 'Position X:');
    kdTextInput(xRow, origin.x.toFixed(2), v => mutate(current => { const live = current.getOrigin(); current.setOrigin(Number(v) || 0, live.y, live.rotation ?? 0); }), true);
    kdUnit(xRow, 'mm');
    const yRow = kdRow(general);
    kdLabel(yRow, 'Position Y:');
    kdTextInput(yRow, origin.y.toFixed(2), v => mutate(current => { const live = current.getOrigin(); current.setOrigin(live.x, Number(v) || 0, live.rotation ?? 0); }), true);
    kdUnit(yRow, 'mm');
  }
  kdCheckRow(general, 'Show pin numbers', !libDef?.arePinNumbersHidden?.(), v => mutateLibDef(current => current.togglePinNumbers(v)));
  kdCheckRow(general, 'Show pin names', !libDef?.arePinNameLabelsHidden?.(), v => mutateLibDef(current => current.togglePinNames(v)));

  const attrs = kdSection(attrCol, 'Attributes');
  kdCheckRow(attrs, 'Exclude from simulation', !!symbol.findFirstChildByName?.('exclude_from_sim')?.value, v => mutate(current => current.setExcludeFromSim(v)));
  kdCheckRow(attrs, 'Exclude from board', symbol.findFirstChildByName?.('on_board')?.value === false, v => mutate(current => current.setOnBoard(!v)));
  kdCheckRow(attrs, 'Do not populate', !!symbol.isDnp?.(), v => mutate(current => current.setDnp(v)));
  kdCheckRow(attrs, 'Exclude from bill of materials', symbol.findFirstChildByName?.('in_bom')?.value === false, v => mutate(current => current.setInBom(!v)));
  kdCheckRow(attrs, 'Exclude from position files', symbol.findFirstChildByName?.('in_pos_files')?.value === false, v => mutate(current => current.setInPosFiles(!v)));

  const libRow = kdRow(body);
  kdLabel(libRow, 'Library link:');
  const libText = document.createElement('span'); libText.style.color = 'var(--text)'; libText.style.fontSize = '11px'; libText.textContent = symbol.getLibId?.() ?? '';
  libRow.appendChild(libText);
}

setMode('view');
ensureSession();
resizeCanvas();
void refreshSymbolLibraryButton();
updateStatusBar();
