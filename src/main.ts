import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { Vec2 } from '@kicad-render/math/Vec2';
import { FINE_GRID_MM } from '@kicad-layout/Geometry';
import {
	applyLockedPinNets,
	isEditablePowerPlacement,
	lockNetlistFromSchematic,
	placeFromInputs,
	rewireMovedComponent,
	rewireMovedLabel,
	rerouteLockedSchematic,
	wrapFullSchematic,
	type CircuitDesignRecipe,
	type CircuitPlacement,
	type LockedNetlist,
} from '@kicad-layout/index';
import { reroute } from '@kicad-layout/Reroute';

type AppMode = 'view' | 'circuit';

const PLACE_GRID = FINE_GRID_MM;
const DEBUG = true;

const statusEl = document.getElementById('status')!;
const scoreEl = document.getElementById('score')!;
const hintEl = document.getElementById('hint')!;
const stage = document.getElementById('stage')!;
const canvas = document.getElementById('canvas2d') as HTMLCanvasElement;
const modeViewBtn = document.getElementById('mode-view')!;
const modeCircuitBtn = document.getElementById('mode-circuit')!;
const viewActions = document.getElementById('view-actions')!;
const circuitActions = document.getElementById('circuit-actions')!;

let mode: AppMode = 'view';
/** Circuit-mode editing (drag / rotate). Always on in circuit mode. */
let editMode = false;
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
let dragRef: string | null = null;
let dragLabelId: string | null = null;
let dragLabelNet: string | null = null;
let dragOffset = new Vec2(0, 0);
let dragMoved = false;
let dragStartPose: { x: number; y: number; rotation: number } | null = null;

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
	}
	catch (err) {
		lockedNetlist = null;
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
		hintEl.textContent = `Edit on · ${n} parts · drag / R · netlist locked · local rewire on drop`;
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

function setMode(next: AppMode): void {
	mode = next;
	editMode = next === 'circuit';
	modeViewBtn.classList.toggle('active', next === 'view');
	modeCircuitBtn.classList.toggle('active', next === 'circuit');
	viewActions.classList.toggle('hidden', next !== 'view');
	circuitActions.classList.toggle('hidden', next !== 'circuit');

	if (next === 'view') {
		setStatus('Open a .kicad_sch or .kicad_pcb file.');
	}
	else if (session?.documentTypeLoaded === 'schematic') {
		if (!lockedNetlist && lastFullSch) {
			lockNetlistFromText(lastFullSch);
		}
		const n = syncPlacementsFromSession();
		setStatus(n
			? (canLockedAutoroute()
				? `Edit mode on — ${n} parts, netlist locked. Drag to auto-rewire.`
				: `Edit mode on — ${n} parts from schematic.`)
			: 'Schematic loaded but no symbol instances found.');
	}
	else {
		setStatus('Open a .kicad_sch here (or Load demo → Place). Drag needs no recipe.');
	}
	updateCircuitHint();
}

async function loadTextIntoSession(text: string, kind: 'schematic' | 'board', filename: string): Promise<void> {
	const s = ensureSession();
	resizeCanvas();
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
		if (mode === 'circuit' || editMode) {
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
		const result = placeFromInputs({
			recipe,
			icSymbolText,
			icMpnFallback: recipe.ic.mpn,
		});
		placements = result.placements;
		placedFragment = result.kicadSchFragment;
		lastFullSch = wrapFullSchematic(result.kicadSchFragment);
		editMode = true;
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

async function commitLocalRewire(
	movedRef: string,
	previousPose: { x: number; y: number; rotation: number }
): Promise<void> {
	if (!canLockedAutoroute() || rerouting) {
		if (canRecipeAutoroute()) {
			await commitReroute('autoroute');
		}
		return;
	}
	rerouting = true;
	setStatus(`Rewiring ${movedRef}…`);
	try {
		const schText = ensureSession().getSchematicText() || lastFullSch;
		if (!lockedNetlist) {
			setStatus('No locked netlist — reopen the schematic in Circuit layout.');
			return;
		}
		const result = rewireMovedComponent({
			schematicText: schText,
			placements,
			movedRef,
			previousPose,
			locked: lockedNetlist,
		});
		// Never replace lockedNetlist — pin↔net map is frozen for the session.
		placements = result.placements;
		lastFullSch = result.kicadSchFull;
		placedFragment = result.kicadSchFull;
		await ensureSession().loadSchematicText(result.kicadSchFull, {
			filename: 'circuit-local-rewire.kicad_sch',
			sheetPath: '/',
			showDrawingSheet: false,
			preserveView: true,
		});
		syncPlacementsFromSession();
		restoreSelection();
		const msg = `Rewired ${movedRef} (ripped ${result.rippedCount}, added ${result.addedCount}).`;
		setStatus(msg);
		setScore(
			result.score.breakdown
			+ (result.warnings.length ? `\n${result.warnings.join('\n')}` : '')
		);
		dbg('local rewire', {
			movedRef,
			ripped: result.rippedCount,
			added: result.addedCount,
			pinRoutes: result.pinRoutes,
			repairedNets: result.repairedNets,
			warnings: result.warnings,
			schTextSource: schText === lastFullSch ? 'lastFullSch' : 'session.write',
			wiresInText: (schText.match(/\(wire\b/g) || []).length,
			wiresOutText: (result.kicadSchFull.match(/\(wire\b/g) || []).length,
			wiresAfterReload: (ensureSession().getSchematicText().match(/\(wire\b/g) || []).length,
		});
		updateCircuitHint();
	}
	catch (err) {
		setStatus(err instanceof Error ? err.message : String(err));
	}
	finally {
		rerouting = false;
	}
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
	setStatus(connectivity === 'clear-wires' ? 'Clearing wires…' : 'Autorouting…');
	try {
		// Prefer locked netlist when present (opened schematic). Recipe Place clears the lock.
		const useLocked = canLockedAutoroute();
		if (useLocked) {
			const schText = ensureSession().getSchematicText() || lastFullSch;
			const result = rerouteLockedSchematic({
				schematicText: schText,
				placements,
				locked: lockedNetlist ?? undefined,
				connectivity,
			});
			// Keep the session lock frozen even if full reroute returns a copy.
			placements = result.placements;
			lastFullSch = result.kicadSchFull;
			placedFragment = result.kicadSchFull;
			await ensureSession().loadSchematicText(result.kicadSchFull, {
				filename: 'circuit-locked-reroute.kicad_sch',
				sheetPath: '/',
				showDrawingSheet: false,
				preserveView: true,
			});
			syncPlacementsFromSession();
			restoreSelection();
			setStatus(connectivity === 'clear-wires' ? 'Wires cleared.' : 'Rewired (full locked netlist).');
			setScore(result.score.breakdown + (result.warnings.length ? `\n${result.warnings.join('\n')}` : ''));
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
	if (!editMode || !session) {
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
	const world = session.screenToWorld(screenPos);
	dragRef = ref;
	dragMoved = false;
	dragStartPose = { x: placement.x, y: placement.y, rotation: placement.rotation };
	dragOffset = new Vec2(world.x - placement.x, world.y - placement.y);
}

async function rotateSelected(): Promise<void> {
	if (!editMode || !selectedRef || rerouting) {
		return;
	}
	const placement = ensurePlacement(selectedRef);
	if (!placement || !session) {
		setStatus('Nothing selected to rotate — click a symbol first.');
		return;
	}
	if (isEditablePowerPlacement(placement)) {
		setStatus('GND orientation is locked');
		return;
	}
	const previousPose = {
		x: placement.x,
		y: placement.y,
		rotation: placement.rotation,
	};
	placement.rotation = (placement.rotation + 90) % 360;
	placements = placements.filter(p => p.ownerRef !== placement.ref);
	session.moveSymbolByRef(placement.ref, placement.x, placement.y, placement.rotation);
	if (canLockedAutoroute()) {
		await commitLocalRewire(placement.ref, previousPose);
	}
	else if (canRecipeAutoroute()) {
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
document.getElementById('btn-autowire')!.addEventListener('click', () => void commitReroute('autoroute'));
document.getElementById('btn-clear-wires')!.addEventListener('click', () => void commitReroute('clear-wires'));
document.getElementById('btn-export')!.addEventListener('click', () => downloadSchematic());

canvas.addEventListener('wheel', (e) => {
	e.preventDefault();
	ensureSession().zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

async function commitLabelRewire(
	labelNet: string,
	previousPose: { x: number; y: number; rotation: number }
): Promise<void> {
	if (!canLockedAutoroute() || rerouting || !lockedNetlist) {
		return;
	}
	rerouting = true;
	setStatus(`Rewiring label ${labelNet}…`);
	try {
		const schText = ensureSession().getSchematicText() || lastFullSch;
		const result = rewireMovedLabel({
			schematicText: schText,
			placements,
			locked: lockedNetlist,
			labelNet,
			previousPose,
		});
		placements = result.placements;
		lastFullSch = result.kicadSchFull;
		placedFragment = result.kicadSchFull;
		await ensureSession().loadSchematicText(result.kicadSchFull, {
			filename: 'circuit-label-rewire.kicad_sch',
			sheetPath: '/',
			showDrawingSheet: false,
			preserveView: true,
		});
		syncPlacementsFromSession();
		setStatus(`Label ${labelNet} rewired (repaired: ${result.repairedNets.join(', ') || 'none'}).`);
		dbg('label rewire', {
			labelNet,
			ripped: result.rippedCount,
			added: result.addedCount,
			pinRoutes: result.pinRoutes,
			repairedNets: result.repairedNets,
		});
	}
	catch (err) {
		setStatus(err instanceof Error ? err.message : String(err));
	}
	finally {
		rerouting = false;
	}
}

canvas.addEventListener('mousedown', (e) => {
	const s = ensureSession();
	const screenPos = screenPosFromEvent(e);
	if (mode === 'circuit' && editMode) {
		const symHit = s.hitTestSymbolAtScreen(screenPos);
		dbg('mousedown hit', symHit);
		if (symHit?.refDesignator) {
			selectedRef = symHit.refDesignator;
			s.select(symHit.id);
			beginSymbolDrag(symHit.refDesignator, screenPos);
			e.preventDefault();
			return;
		}
		const labelHit = s.hitTestLabelAtScreen(screenPos);
		if (labelHit?.id && labelHit.labelName) {
			selectedRef = null;
			s.select(labelHit.id);
			const world = s.screenToWorld(screenPos);
			// Label attach point ≈ item element origin; use world click offset.
			const el = (s as any).schScene?.hitTestItems?.find((it: any) => it.id === labelHit.id)?.element;
			const origin = el?.getOrigin?.() ?? { x: world.x, y: world.y, rotation: 0 };
			dragLabelId = labelHit.id;
			dragLabelNet = labelHit.labelName;
			dragMoved = false;
			dragStartPose = { x: origin.x, y: origin.y, rotation: origin.rotation ?? 0 };
			dragOffset = new Vec2(world.x - origin.x, world.y - origin.y);
			dbg('beginLabelDrag', { id: labelHit.id, net: labelHit.labelName, origin });
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
		const placement = placements.find(p => p.ref === dragRef);
		if (!placement) return;
		const worldPos = s.screenToWorld(pos);
		const nx = snap(worldPos.x - dragOffset.x);
		const ny = snap(worldPos.y - dragOffset.y);
		const dx = nx - placement.x;
		const dy = ny - placement.y;
		placement.x = nx;
		placement.y = ny;
		if (isEditablePowerPlacement(placement)) {
			placement.rotation = 0;
		}
		if (dragStartPose && (nx !== dragStartPose.x || ny !== dragStartPose.y)) {
			dragMoved = true;
		}
		s.moveSymbolByRef(placement.ref, placement.x, placement.y, placement.rotation);
		if (!isEditablePowerPlacement(placement) && (dx !== 0 || dy !== 0)) {
			for (const g of placements) {
				if (g.ownerRef !== placement.ref) continue;
				g.x = snap(g.x + dx);
				g.y = snap(g.y + dy);
				g.rotation = 0;
				s.moveSymbolByRef(g.ref, g.x, g.y, 0);
			}
		}
		return;
	}
	if (!draggingPan) return;
	s.pan(pos.x - dragStart.x, pos.y - dragStart.y);
	dragStart = pos;
}

function onPointerUp(): void {
	const finishingSym = dragRef;
	const finishingLabel = dragLabelId;
	const finishingLabelNet = dragLabelNet;
	const moved = dragMoved;
	const prev = dragStartPose;
	dragRef = null;
	dragLabelId = null;
	dragLabelNet = null;
	draggingPan = false;
	if (mode === 'circuit' && editMode && finishingLabel && finishingLabelNet && moved && prev) {
		void commitLabelRewire(finishingLabelNet, prev);
	}
	else if (mode === 'circuit' && editMode && finishingSym && moved && prev) {
		void commitLocalRewire(finishingSym, prev);
	}
	dragMoved = false;
	dragStartPose = null;
}

window.addEventListener('mousemove', onPointerMove);
window.addEventListener('mouseup', onPointerUp);

window.addEventListener('keydown', (e) => {
	if (mode !== 'circuit' || !editMode) return;
	const t = e.target as HTMLElement | null;
	if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
	if (e.key === 'Escape') {
		selectedRef = null;
		session?.select(null);
		return;
	}
	if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
		e.preventDefault();
		void rotateSelected();
	}
});

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
