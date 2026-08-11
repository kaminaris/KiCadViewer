import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import {
	applyLockedPinNets, isEditablePowerPlacement, lockNetlistFromSchematic, pinsForLockedLib, placeFromInputs,
	rewireSchematic, symbolFieldLayout, wrapFullSchematic, type CircuitDesignRecipe, type CircuitPlacement,
	type LockedNetlist
}                             from '@kicad-layout/index';
import { reroute }            from '@kicad-layout/Reroute';
import type { AppMode }       from './AppState';
import type { AppState }      from './AppState';
import type { Settings }      from './Settings';
import type { StatusBar }     from './StatusBar';
import type { MainDomRefs }   from './domRefs';

/** Mutable state still owned by main.ts during the staged refactor. The
 * controller uses this narrow adapter instead of reaching for loose module
 * globals directly; routing/placement ownership moves here in the next pass. */
export interface SessionControllerState {
	mode: AppMode;
	circuitDragMode: boolean;
	session: KicadRenderSession | null;
	lockedNetlist: LockedNetlist | null;
	placements: CircuitPlacement[];
	placedFragment: string;
	selectedRef: string | null;
	editSelectedId: string | null;
	rerouting: boolean;
	recipe: CircuitDesignRecipe | null;
	icSymbolText: string;
}

export interface SessionControllerCallbacks {
	closeSymbolChooser(): void;

	resetEditToolState(): void;

	refreshHint(): void;

	refreshSidebar(): void;

	clearLastPointer(): void;

	lockNetlistFromText(text: string, force: boolean): void;

	syncPlacementsFromSession(): number;

	canLockedAutoroute(): boolean;

	relockNetlistFromLiveText(): void;

	restoreSelection(): void;

	ensurePlacement(ref: string): CircuitPlacement | null;

	canAutoroute(): boolean;

	commitReroute(): Promise<void>;

	updateLockedNets(): void;
}

/** Owns render-session construction, mode presentation, and document loading.
 * Circuit routing remains in main.ts temporarily because its gesture callers
 * still share the placement and selection variables directly. */
export class SessionController {
	constructor(
		protected readonly state: SessionControllerState,
		protected readonly appState: AppState,
		protected readonly settings: Settings,
		protected readonly statusBar: StatusBar,
		protected readonly dom: MainDomRefs,
		protected readonly callbacks: SessionControllerCallbacks
	) {}

	ensureSession(): KicadRenderSession {
		if (!this.state.session) {
			this.state.session = new KicadRenderSession(this.dom.canvas, this.dom.canvasGl);
			this.state.session.onError = error => this.statusBar.setStatus(
				error instanceof Error ? error.message : String(error));
			this.state.session.onRender = () => this.statusBar.recordRender();
			this.state.session.setGridSpacing(this.settings.current.gridSpacingMm);
			if (!this.state.session.hasWebGL) {
				// WebGL context creation failed (disabled GPU, headless
				// environment, etc.) — the session already fell back to
				// Canvas2D internally; swap which canvas is visible to match.
				this.dom.canvas.classList.remove('hidden');
				this.dom.canvasGl.classList.add('hidden');
				this.statusBar.dbg('WebGL unavailable, using Canvas2D fallback');
			}
		}
		return this.state.session;
	}

	resizeCanvas(): void {
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.floor(this.dom.stage.clientWidth * dpr));
		const height = Math.max(1, Math.floor(this.dom.stage.clientHeight * dpr));
		this.ensureSession().resize(width, height);
	}

	setMode(next: AppMode): void {
		this.state.mode = next;
		this.state.circuitDragMode = next === 'circuit';
		this.dom.modeViewBtn.classList.toggle('active', next === 'view');
		this.dom.modeCircuitBtn.classList.toggle('active', next === 'circuit');
		this.dom.modeEditBtn.classList.toggle('active', next === 'edit');
		this.dom.viewActions.classList.toggle('hidden', next !== 'view');
		this.dom.circuitActions.classList.toggle('hidden', next !== 'circuit');
		this.dom.editActions.classList.toggle('hidden', next !== 'edit');
		this.dom.editLeftPane.classList.toggle('hidden', next !== 'edit');
		this.dom.toolPanel.classList.toggle('hidden', next !== 'edit');
		this.dom.mainEl.classList.toggle('edit-mode', next === 'edit');
		if (next !== 'edit') {
			this.callbacks.closeSymbolChooser();
			this.callbacks.resetEditToolState();
		}

		if (next === 'view') {
			this.statusBar.setStatus('Open a .kicad_sch or .kicad_pcb file.');
		}
		else if (next === 'circuit' && this.state.session?.documentTypeLoaded === 'schematic') {
			const liveText = this.appState.refreshSchematicText(this.state.session);
			if (liveText) {
				this.callbacks.lockNetlistFromText(liveText, true);
			}
			const count = this.callbacks.syncPlacementsFromSession();
			this.statusBar.setStatus(count
				? (this.callbacks.canLockedAutoroute()
					? `Edit mode on — ${ count } parts, netlist locked. Drag to auto-rewire.`
					: `Edit mode on — ${ count } parts from schematic.`)
				: 'Schematic loaded but no symbol instances found.');
		}
		else if (next === 'edit') {
			this.statusBar.setStatus(this.state.session?.documentTypeLoaded === 'schematic'
				? 'Edit mode on — select tool active. Click a tool below to draw.'
				: 'Open a .kicad_sch to start hand-drawing wires/junctions/graphics.');
		}
		else {
			this.statusBar.setStatus('Open a .kicad_sch here (or Load demo → Place). Drag needs no recipe.');
		}
		this.callbacks.refreshHint();
		this.callbacks.refreshSidebar();
	}

	/** Returns false (and reports the failure via the status bar) if the file
	 *  couldn't be parsed/loaded — malformed input or an unsupported KiCad
	 *  construct shouldn't crash the app for someone just viewing a file. */
	async loadText(text: string, kind: 'schematic' | 'board', filename: string): Promise<boolean> {
		const session = this.ensureSession();
		this.resizeCanvas();
		try {
			session.resetUndoHistory();
			this.callbacks.clearLastPointer();
			if (kind === 'board') {
				await session.loadBoardText(text);
				this.state.placements = [];
				this.state.lockedNetlist = null;
				if (this.state.mode === 'circuit') {
					this.statusBar.setStatus('Boards are view-only — open a schematic to edit placements.');
				}
			}
			else {
				this.appState.setSchematicText(text);
				this.state.placedFragment = text;
				this.callbacks.lockNetlistFromText(text, true);
				await session.loadSchematicText(text, {
					filename,
					sheetPath: '/',
					showDrawingSheet: this.state.mode === 'view'
				});
				if (this.state.mode === 'circuit' || this.state.circuitDragMode) {
					const count = this.callbacks.syncPlacementsFromSession();
					const nets = this.state.lockedNetlist?.summary.netCount ?? 0;
					this.statusBar.setStatus(count
						? (this.callbacks.canLockedAutoroute()
							? `Edit on — ${ count } parts, ${ nets } nets locked. Drag / R to auto-rewire.`
							: `Edit on — ${ count } parts (could not lock nets for rewire).`)
						: 'Schematic loaded but no symbol instances found to edit.');
				}
			}
		}
		catch (error) {
			this.statusBar.dbg('loadText failed', { kind, filename, error });
			this.statusBar.setStatus(
				`Could not load ${ filename } — ${ error instanceof Error ? error.message : String(error) }`);
			// Resync the cache to whatever the session actually has loaded (the
			// failed parse may have left it unchanged) rather than the broken
			// text optimistically written above.
			this.appState.refreshSchematicText(session);
			return false;
		}
		this.callbacks.refreshHint();
		this.callbacks.refreshSidebar();
		return true;
	}

	async openKiCadFile(file: File): Promise<void> {
		try {
			const text = await file.text();
			const name = file.name.toLowerCase();
			this.statusBar.dbg('openKiCadFile', { name, mode: this.state.mode, bytes: text.length });
			if (name.endsWith('.kicad_pcb')) {
				if (await this.loadText(text, 'board', file.name) && this.state.mode === 'view') {
					this.statusBar.setStatus(`Loaded board ${ file.name }`);
				}
			}
			else if (await this.loadText(text, 'schematic', file.name) && this.state.mode === 'view') {
				this.statusBar.setStatus(`Loaded schematic ${ file.name }. Switch to Circuit layout to drag/rotate.`);
			}
		}
		catch (error) {
			this.statusBar.setStatus(
				`Could not open ${ file.name } — ${ error instanceof Error ? error.message : String(error) }`);
		}
	}

	async loadDemo(): Promise<void> {
		const [recipeResponse, symbolResponse] = await Promise.all([
			fetch('/demo/recipe.json'),
			fetch('/demo/demo-ic.kicad_sym')
		]);
		if (!recipeResponse.ok || !symbolResponse.ok) {
			throw new Error('Demo assets missing under public/demo.');
		}
		this.state.recipe = await recipeResponse.json() as CircuitDesignRecipe;
		this.state.icSymbolText = await symbolResponse.text();
		this.statusBar.setStatus('Demo recipe + symbol loaded. Click Place.');
		this.statusBar.setScore('');
		this.callbacks.refreshHint();
	}

	runPlace(): void {
		const { recipe, icSymbolText } = this.state;
		if (!recipe || !icSymbolText.trim()) {
			this.statusBar.setStatus('Need recipe + IC symbol first (Load demo or pick files).');
			return;
		}
		try {
			this.state.lockedNetlist = null;
			this.callbacks.updateLockedNets();
			const result = placeFromInputs({ recipe, icSymbolText, icMpnFallback: recipe.ic.mpn });
			this.state.placements = result.placements;
			this.state.placedFragment = result.kicadSchFragment;
			this.appState.setSchematicText(wrapFullSchematic(result.kicadSchFragment));
			this.state.circuitDragMode = true;
			void this.loadText(this.appState.schematicText, 'schematic', 'circuit-place.kicad_sch').then(loaded => {
				if (!loaded) {
					return;
				}
				this.state.lockedNetlist = null;
				this.state.placements = result.placements;
				this.statusBar.setStatus(
					`Edit mode on — placed ${ this.state.placements.length } parts. Drag or Auto wire.`);
				this.statusBar.setScore(result.warnings.join('\n'));
				this.callbacks.refreshHint();
			});
		}
		catch (error) {
			this.statusBar.setStatus(error instanceof Error ? error.message : String(error));
		}
	}

	canRecipeAutoroute(): boolean {
		return !!this.state.recipe && !!this.state.icSymbolText.trim() && this.state.placements.length > 0;
	}

	canLockedAutoroute(): boolean { return !!this.state.lockedNetlist && this.state.placements.length > 0; }

	canAutoroute(): boolean { return this.canRecipeAutoroute() || this.canLockedAutoroute(); }

	lockNetlistFromText(text: string, force = false): void {
		if (this.state.lockedNetlist && !force) {
			return;
		}
		try {
			this.state.lockedNetlist = lockNetlistFromSchematic(text);
			if (this.state.lockedNetlist.warnings.length) {
				this.statusBar.setScore(
					this.state.lockedNetlist.warnings.join('\n'));
			}
		}
		catch (error) {
			this.state.lockedNetlist = null;
			this.statusBar.dbg('lockNetlist failed', error);
			this.statusBar.setScore(error instanceof Error ? error.message : String(error));
		}
		this.callbacks.updateLockedNets();
	}

	protected placementFromPose(pose: {
		ref: string;
		libId: string;
		x: number;
		y: number;
		rotation: number
	}): CircuitPlacement {
		const pinNets = this.state.lockedNetlist?.pinNetsByRef[pose.ref] ?? {};
		return {
			ref: pose.ref,
			role: pose.libId === 'power:GND' || pose.ref.startsWith('#PWR') ? 'GND' : 'PART',
			libId: pose.libId || 'Unknown',
			x: pose.x,
			y: pose.y,
			rotation: pose.rotation,
			value: pose.ref,
			nets: Object.values(pinNets),
			pinNets: { ...pinNets }
		};
	}

	syncPlacementsFromSession(): number {
		const session = this.state.session;
		if (!session) {
			this.state.placements = [];
			return 0;
		}
		this.state.placements = session.listSymbolPoses().map(pose => this.placementFromPose(pose));
		if (this.state.lockedNetlist) {
			this.state.placements = applyLockedPinNets(
				this.state.placements, this.state.lockedNetlist);
		}
		this.callbacks.refreshHint();
		return this.state.placements.length;
	}

	ensurePlacement(ref: string): CircuitPlacement | null {
		let placement = this.state.placements.find(item => item.ref === ref);
		if (placement) {
			return placement;
		}
		const pose = this.state.session?.getSymbolPose(ref);
		if (!pose) {
			return null;
		}
		placement = this.placementFromPose(pose);
		if (this.state.lockedNetlist) {
			placement = applyLockedPinNets([placement], this.state.lockedNetlist)[0]!;
		}
		this.state.placements.push(placement);
		this.callbacks.refreshHint();
		return placement;
	}

	relockNetlistFromLiveText(): void {
		if (this.state.session?.documentTypeLoaded !== 'schematic') {
			return;
		}
		const text = this.appState.refreshSchematicText(this.state.session);
		if (text) {
			this.lockNetlistFromText(text, true);
		}
	}

	restoreSelection(): void {
		const { selectedRef, session, mode, editSelectedId } = this.state;
		if (!selectedRef || !session) {
			return;
		}
		const items = session.activeScene?.hitTestItems ?? [];
		const hit = mode === 'edit' && editSelectedId
			? items.find(item => item.id === editSelectedId)
			: items.find(item => (item as any).kind === 'symbol' && (item as any).refDesignator === selectedRef);
		session.select(hit?.id ?? null);
	}

	async commitReroute(connectivity: 'autoroute' | 'clear-wires' = 'autoroute'): Promise<void> {
		if (!this.canAutoroute() || this.state.rerouting) {
			if (!this.canAutoroute() && this.state.mode === 'circuit') {
				this.statusBar.setStatus(
					'Moved. Open a wired schematic to lock nets, or Load demo → Place.');
			}
			return;
		}
		this.state.rerouting = true;
		this.statusBar.setStatus(connectivity === 'clear-wires' ? 'Clearing wires…' : 'Rewiring…');
		try {
			if (this.canLockedAutoroute()) {
				const result = rewireSchematic({
					schematicText: this.appState.refreshSchematicText(this.ensureSession()),
					placements: this.state.placements,
					locked: this.state.lockedNetlist ?? undefined,
					connectivity
				});
				this.state.placements = result.placements;
				this.state.placedFragment = result.kicadSchFull;
				this.appState.setSchematicText(result.kicadSchFull);
				await this.ensureSession()
					.loadSchematicText(result.kicadSchFull, {
						filename: 'circuit-rewire.kicad_sch',
						sheetPath: '/',
						showDrawingSheet: false,
						preserveView: true
					});
				this.syncPlacementsFromSession();
				this.restoreSelection();
				this.statusBar.setStatus(
					connectivity === 'clear-wires' ? 'Wires cleared — every pin flagged with a net label.' :
						result.invalidNets.length ?
							`Rewired — ${ result.invalidNets.length } net(s) need attention (red): ${ result.invalidNets.join(
								', ') }. Move parts apart to clear.` : 'Rewired — all nets clean.');
				this.statusBar.setScore(
					result.score.breakdown + (result.warnings.length ? `\n${ result.warnings.join('\n') }` : ''));
			}
			else {
				const recipe = this.state.recipe!;
				const result = reroute({
					recipe,
					icSymbolText: this.state.icSymbolText,
					placements: this.state.placements,
					icMpnFallback: recipe.ic.mpn,
					connectivity
				});
				this.state.placements = result.placements;
				this.state.placedFragment = result.kicadSchFragment;
				this.appState.setSchematicText(result.kicadSchFull);
				await this.ensureSession()
					.loadSchematicText(result.kicadSchFull, {
						filename: 'circuit-reroute.kicad_sch',
						sheetPath: '/',
						showDrawingSheet: false,
						preserveView: true
					});
				this.restoreSelection();
				this.statusBar.setStatus(connectivity === 'clear-wires' ? 'Wires cleared.' : 'Rewired (recipe).');
				this.statusBar.setScore(
					result.score.breakdown + (result.warnings.length ? `\n${ result.warnings.join('\n') }` : ''));
			}
			this.callbacks.refreshHint();
		}
		catch (error) {
			this.statusBar.setStatus(error instanceof Error ? error.message : String(error));
		}
		finally {
			this.state.rerouting = false;
		}
	}

	async undo(): Promise<void> {
		const session = this.state.session;
		if (!session?.canUndo || !await session.undo()) {
			this.statusBar.setStatus('Nothing to undo.');
			return;
		}
		this.appState.refreshSchematicText(session);
		this.callbacks.syncPlacementsFromSession();
		if (this.state.mode === 'circuit') {
			this.callbacks.relockNetlistFromLiveText();
		}
		this.callbacks.restoreSelection();
		this.statusBar.setStatus('Undo.');
		this.callbacks.refreshHint();
		this.callbacks.refreshSidebar();
	}

	async redo(): Promise<void> {
		const session = this.state.session;
		if (!session?.canRedo || !await session.redo()) {
			this.statusBar.setStatus('Nothing to redo.');
			return;
		}
		this.appState.refreshSchematicText(session);
		this.callbacks.syncPlacementsFromSession();
		if (this.state.mode === 'circuit') {
			this.callbacks.relockNetlistFromLiveText();
		}
		this.callbacks.restoreSelection();
		this.statusBar.setStatus('Redo.');
		this.callbacks.refreshHint();
		this.callbacks.refreshSidebar();
	}

	downloadSchematic(filenameBase: string, fallbackText: string): void {
		const text = this.appState.schematicText.trim() || fallbackText.trim();
		if (!text) {
			this.statusBar.setStatus('Nothing to export — Place or open a schematic first.');
			return;
		}
		const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${ filenameBase || 'circuit' }.kicad_sch`;
		link.click();
		URL.revokeObjectURL(url);
		this.statusBar.setStatus('Downloaded schematic.');
	}

	async rotateSelected(): Promise<void> {
		const { session, selectedRef, mode } = this.state;
		if (!selectedRef || !session || this.state.rerouting) {
			return;
		}
		if (mode === 'edit') {
			const instanceId = this.state.editSelectedId ?? undefined;
			const pose = session.getSymbolPose(selectedRef, instanceId);
			if (!pose) {
				this.statusBar.setStatus('Nothing selected to rotate — click a symbol first.');
				return;
			}
			session.pushUndoSnapshot();
			const rotation = (pose.rotation + 90) % 360;
			session.moveSymbolByRef(selectedRef, pose.x, pose.y, rotation, instanceId);
			this.appState.refreshSchematicText(session);
			this.statusBar.setStatus(`Rotated ${ selectedRef } to ${ rotation }°.`);
			return;
		}
		if (!this.state.circuitDragMode) {
			return;
		}
		const placement = this.callbacks.ensurePlacement(selectedRef);
		if (!placement) {
			this.statusBar.setStatus('Nothing selected to rotate — click a symbol first.');
			return;
		}
		if (isEditablePowerPlacement(placement)) {
			this.statusBar.setStatus('GND orientation is locked');
			return;
		}
		session.pushUndoSnapshot();
		placement.rotation = (placement.rotation + 90) % 360;
		session.moveSymbolByRef(placement.ref, placement.x, placement.y, placement.rotation);
		if (this.callbacks.canAutoroute()) {
			await this.callbacks.commitReroute();
		}
		else {
			this.statusBar.setStatus(`Rotated ${ placement.ref } to ${ placement.rotation }°.`);
		}
	}

	tidySelectedFields(): void {
		const { session, selectedRef, mode } = this.state;
		if ((!this.state.circuitDragMode && mode !== 'edit') || !selectedRef || !session) {
			this.statusBar.setStatus('Click a component first, then press T to tidy its labels.');
			return;
		}
		const instanceId = mode === 'edit' ? (this.state.editSelectedId ?? undefined) : undefined;
		const pose = session.getSymbolPose(selectedRef, instanceId);
		if (!pose) {
			return;
		}
		const pins = this.state.lockedNetlist ? pinsForLockedLib(pose.libId, this.state.lockedNetlist.pinsByLib) : [];
		const layout = symbolFieldLayout(pose.libId, pose.x, pose.y, pose.rotation, pins);
		session.pushUndoSnapshot();
		if (session.autoplaceSymbolFields(selectedRef, layout, instanceId)) {
			this.appState.refreshSchematicText(session);
			this.statusBar.setStatus(`Tidied labels for ${ selectedRef }.`);
		}
	}
}
