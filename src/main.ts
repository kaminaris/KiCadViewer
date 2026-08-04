import { KicadRenderSession, type EditPreviewState, type KicadGlobalLabelShape, type KicadDirectiveLabelShape } from '@kicad-render/KicadRenderSession';
import { Vec2 } from '@kicad-render/math/Vec2';
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

type AppMode = 'view' | 'circuit' | 'edit';
type EditTool =
	| 'select' | 'wire' | 'bus' | 'bus-entry' | 'junction' | 'no-connect' | 'line' | 'rect' | 'circle' | 'arc' | 'text'
	| 'label' | 'directive-label' | 'global-label' | 'hier-label' | 'power' | 'delete';

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
const TOOL_GROUPS: ToolGroupDef[] = [LABEL_GROUP];

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

const PLACE_GRID = FINE_GRID_MM;
const DEBUG = true;

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
const toolPanel = document.getElementById('tool-panel')!;
const mainEl = document.querySelector('main')!;
const editTextInput = document.getElementById('edit-text-input') as HTMLInputElement;
const contextMenuEl = document.getElementById('context-menu') as HTMLDivElement;
const editToolButtons = Array.from(
	document.querySelectorAll<HTMLButtonElement>('#tool-panel [data-tool]')
);

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
/** Global / hierarchical label being dragged (local labels are regenerated). */
let dragLabelId: string | null = null;
let dragOffset = new Vec2(0, 0);
let dragMoved = false;
let dragStartPose: { x: number; y: number; rotation: number } | null = null;

// ---- Edit mode: hand-drawn wires/junctions/no-connects/graphics ----
let editTool: EditTool = 'select';
/** Wire/bus tools: last committed chain point (world, snapped), or null if no chain in progress. */
let lineChainStart: Vec2 | null = null;
/** Line/rect/circle tools: first-click anchor, or null before it. */
let shapeAnchor: Vec2 | null = null;
/** Arc tool: 0, 1 ([start]), or 2 ([start, end]) points clicked so far. */
let arcPoints: Vec2[] = [];
/** Select tool: non-symbol element (wire/junction/no-connect/graphic/text) being dragged. */
let editDragId: string | null = null;
let editDragLastPos: Vec2 | null = null;
/** Select tool: paint-item id/kind of whatever's currently selected (for Delete-key policy). */
let editSelectedId: string | null = null;
let editSelectedKind: string | null = null;
/** Text tool: world position of the pending (not-yet-committed) text. */
let pendingTextAnchor: Vec2 | null = null;
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
	toolPanel.classList.toggle('hidden', next !== 'edit');
	mainEl.classList.toggle('edit-mode', next === 'edit');
	if (next !== 'edit') {
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
}

async function loadTextIntoSession(text: string, kind: 'schematic' | 'board', filename: string): Promise<void> {
	const s = ensureSession();
	resizeCanvas();
	// A genuinely NEW document — undo must not step back into whatever was
	// open before. (undo()/redo() themselves call the session's own
	// loadSchematicText directly, bypassing this wrapper, so they never hit this.)
	s.resetUndoHistory();
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
	const hit = items.find(item =>
		(item as { kind?: string; refDesignator?: string }).kind === 'symbol'
		&& (item as { refDesignator?: string }).refDesignator === selectedRef
	);
	session.select(hit?.id ?? null);
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
	session.pushUndoSnapshot();
	const world = session.screenToWorld(screenPos);
	dragRef = ref;
	dragMoved = false;
	dragStartPose = { x: placement.x, y: placement.y, rotation: placement.rotation };
	dragOffset = new Vec2(world.x - placement.x, world.y - placement.y);
}

/** Edit mode's select-tool symbol drag start — sources the pose directly
 *  from the live AST, unlike circuit mode's placements-array-backed variant
 *  (edit mode never touches placements/pinNets — it's not net-aware). */
function beginEditSymbolDrag(ref: string, screenPos: Vec2): void {
	if (!session) {
		return;
	}
	const pose = session.getSymbolPose(ref);
	if (!pose) {
		return;
	}
	session.pushUndoSnapshot();
	const world = session.screenToWorld(screenPos);
	dragRef = ref;
	dragMoved = false;
	dragStartPose = { x: pose.x, y: pose.y, rotation: pose.rotation };
	dragOffset = new Vec2(world.x - pose.x, world.y - pose.y);
}

async function rotateSelected(): Promise<void> {
	if (!selectedRef || !session || rerouting) {
		return;
	}
	if (mode === 'edit') {
		const pose = session.getSymbolPose(selectedRef);
		if (!pose) {
			setStatus('Nothing selected to rotate — click a symbol first.');
			return;
		}
		if (isEditablePowerPlacement({ libId: pose.libId, ref: selectedRef })) {
			setStatus('GND orientation is locked');
			return;
		}
		session.pushUndoSnapshot();
		const newRotation = (pose.rotation + 90) % 360;
		session.moveSymbolByRef(selectedRef, pose.x, pose.y, newRotation);
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
			setEditTool(tool);
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
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
	// A click that's just dismissing the open context menu shouldn't ALSO
	// act on whatever's underneath it (place/select/pan) — swallow it here;
	// the window 'click' listener still runs afterward and closes the menu.
	if (!contextMenuEl.classList.contains('hidden')) {
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

	if (mode === 'edit' && editTool !== 'select') {
		const worldPos = s.screenToWorld(pos);
		updateEditPreview(s, new Vec2(snap(worldPos.x), snap(worldPos.y)));
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
	if (dragRef) {
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - dragOffset.x);
		const ny = snap(worldPos.y - dragOffset.y);
		if (mode === 'edit') {
			// Manual move — no placements bookkeeping, no rewire on drop.
			if (dragStartPose && (nx !== dragStartPose.x || ny !== dragStartPose.y)) {
				dragMoved = true;
			}
			s.moveSymbolByRef(dragRef, nx, ny, dragStartPose?.rotation ?? 0);
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

function onPointerUp(): void {
	const finishingSym = dragRef;
	const finishingLabel = dragLabelId;
	const finishingEditDrag = editDragId;
	const moved = dragMoved;
	dragRef = null;
	dragLabelId = null;
	editDragId = null;
	editDragLastPos = null;
	draggingPan = false;
	// Any symbol OR global/hier label move → full net-locked rewire (the single
	// edit path; the moved label/rail is preserved and wires re-route to it).
	if (mode === 'circuit' && circuitDragMode && (finishingSym || finishingLabel) && moved) {
		void commitReroute('autoroute');
	}
	else if (mode === 'edit' && (finishingSym || finishingEditDrag) && moved && session) {
		// Manual move, no rewire — just persist the mutated AST text.
		lastFullSch = session.getSchematicText() || lastFullSch;
	}
	dragMoved = false;
	dragStartPose = null;
}

canvas.addEventListener('dblclick', () => {
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
	if (!session?.canUndo) {
		return;
	}
	await session.undo();
	syncPlacementsFromSession();
	if (mode === 'circuit') {
		relockNetlistFromLiveText();
	}
	restoreSelection();
	setStatus('Undo.');
	updateCircuitHint();
}

async function performRedo(): Promise<void> {
	if (!session?.canRedo) {
		return;
	}
	await session.redo();
	syncPlacementsFromSession();
	if (mode === 'circuit') {
		relockNetlistFromLiveText();
	}
	restoreSelection();
	setStatus('Redo.');
	updateCircuitHint();
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

	if (mode === 'edit') {
		// Tool-switch hotkeys. R/T are already rotate/tidy below, so Rect and
		// Text stay button-only (no letter available without a collision).
		const hotkeyTool = EDIT_TOOL_HOTKEYS[e.key.toLowerCase()];
		if (!e.ctrlKey && !e.metaKey && !e.altKey && hotkeyTool) {
			e.preventDefault();
			setEditTool(hotkeyTool);
			return;
		}
		if (e.key === 'Escape') {
			if (!contextMenuEl.classList.contains('hidden')) {
				closeContextMenu();
			}
			else if (lineChainStart || shapeAnchor || arcPoints.length) {
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
		if ((e.key === 'Delete' || e.key === 'Backspace') && editTool === 'select' && editSelectedId) {
			if (editSelectedKind === 'symbol') {
				setStatus("Symbols aren't deletable in edit mode.");
				return;
			}
			e.preventDefault();
			const removed = session?.deleteElements([editSelectedId]) ?? 0;
			if (removed) {
				lastFullSch = session?.getSchematicText() || lastFullSch;
				setStatus('Deleted.');
			}
			editSelectedId = null;
			editSelectedKind = null;
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
	const pose = session.getSymbolPose(selectedRef);
	if (!pose) {
		return;
	}
	const pins = lockedNetlist ? pinsForLockedLib(pose.libId, lockedNetlist.pinsByLib) : [];
	const layout = symbolFieldLayout(pose.libId, pose.x, pose.y, pose.rotation, pins);
	session.pushUndoSnapshot();
	if (session.autoplaceSymbolFields(selectedRef, layout)) {
		lastFullSch = session.getSchematicText() || lastFullSch;
		setStatus(`Tidied labels for ${selectedRef}.`);
	}
}

// ---- Edit mode: tool switching, text input, preview ----

/** Clear every in-progress edit-mode gesture (chain/anchor/points/drag/text)
 *  and the live preview — called on tool switch and on leaving edit mode. */
function resetEditToolState(): void {
	lineChainStart = null;
	shapeAnchor = null;
	arcPoints = [];
	currentLabelShape = 'input';
	currentDirectiveLabelShape = 'round';
	editDragId = null;
	editDragLastPos = null;
	hideTextInput();
	closeContextMenu();
	session?.setEditPreview(null);
}

function setEditTool(tool: EditTool): void {
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
	pendingTextAnchor = null;
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
		submenu.appendChild(menuItem(btn.title || tool, () => setEditTool(tool), btn.disabled));
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
	if (lineChainStart || shapeAnchor || arcPoints.length) {
		resetEditToolState();
		return;
	}
	const s = ensureSession();
	const hit = s.hitTestAtScreen(screenPosFromEvent(e));
	const items: HTMLElement[] = [];

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
		case 'arc':
			preview = { kind: 'arc', points: arcPoints, cursor };
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
	const snapped = new Vec2(snap(worldPos.x), snap(worldPos.y));
	const samePoint = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;

	if (editTool === 'select') {
		// Selection and drag start are primary-button actions only. Returning
		// false lets middle-button input continue to the canvas pan path and
		// prevents it from unexpectedly changing selection under the cursor.
		if (e.button !== 0) {
			return false;
		}
		const hit = s.hitTestAtScreen(screenPos);
		if (hit?.kind === 'symbol' && hit.refDesignator) {
			selectedRef = hit.refDesignator;
			editSelectedId = hit.id;
			editSelectedKind = hit.kind;
			s.select(hit.id);
			beginEditSymbolDrag(hit.refDesignator, screenPos);
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
		selectedRef = null;
		editSelectedId = null;
		editSelectedKind = null;
		s.select(null);
		return false;
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

	if (editTool === 'line' || editTool === 'rect' || editTool === 'circle') {
		if (!shapeAnchor) {
			shapeAnchor = snapped;
		}
		else if (samePoint(snapped, shapeAnchor)) {
			shapeAnchor = null;
			s.setEditPreview(null);
		}
		else {
			if (editTool === 'line') {
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
stage.addEventListener('drop', (e) => {
	e.preventDefault();
	const file = e.dataTransfer?.files?.[0];
	if (!file) return;
	void openKiCadFile(file);
});

setMode('view');
ensureSession();
resizeCanvas();
