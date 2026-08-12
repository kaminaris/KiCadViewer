import { KicadRenderSession }                                           from '@kicad-render/KicadRenderSession';
import type { Vec2 }                                                    from '@kicad-render/math/Vec2';
import type { SchematicDocInfo }                                        from '@kicad-render/paint/SchematicPainter';
import {
	applyLockedPinNets, isEditablePowerPlacement, lockNetlistFromSchematic, pinsForLockedLib, placeFromInputs,
	rewireSchematic, symbolFieldLayout, wrapFullSchematic, type CircuitDesignRecipe, type CircuitPlacement,
	type LockedNetlist
}                                                                       from '@kicad-layout/index';
import { reroute }                                                      from '@kicad-layout/Reroute';
import { KicadProject }                                                 from '@kicad-io/Project/KicadProject';
import { KicadSchematic }                                               from '@kicad-io/Project/KicadSchematic';
import { KicadParser }                                                  from '@kicad-io/KicadParser';
import { BrowserFsAdapter, getDirectoryPicker, type FsDirectoryHandle } from './BrowserFsAdapter';
import { ZipArchive }                                                   from './ZipArchive';
import { ZipFsAdapter }                                                 from './ZipFsAdapter';
import type { AppMode }                                                 from './AppState';
import type { AppState }                                                from './AppState';
import type { Settings }                                                from './Settings';
import type { StatusBar }                                               from './StatusBar';
import type { MainDomRefs }                                             from './domRefs';

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
	/** The whole open project (root schematic + full hierarchy + board +
	 *  .kicad_pro), when opened via openProjectFolder() — null in plain
	 *  single-file mode (the pre-existing openKiCadFile/loadText path,
	 *  unaffected by any of this). */
	protected currentProject: KicadProject | null = null;
	/** The adapter backing currentProject's storage — kept alongside it so
	 *  saveProject() can write through the same picked directory handle. */
	protected fsAdapter: BrowserFsAdapter | null = null;
	/** Which node of currentProject's hierarchy is CURRENTLY loaded into the
	 *  render session — the render session only ever holds one document at
	 *  a time, so this tracks which tree node that corresponds to, both for
	 *  hierarchy-panel highlighting and so saveProject() knows which node to
	 *  re-sync from the live (possibly edited) session text before writing
	 *  the whole tree back out. */
	protected currentSheetNode: KicadSchematic | null = null;

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
	async loadText(
		text: string,
		kind: 'schematic' | 'board',
		filename: string,
		options?: { showDrawingSheet?: boolean }
	): Promise<boolean> {
		const session = this.ensureSession();
		this.resizeCanvas();
		try {
			session.resetUndoHistory();
			this.callbacks.clearLastPointer();
			const showDrawingSheet = options?.showDrawingSheet ?? true;
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
				await session.loadSchematicText(text, this.buildSchematicDocInfo(filename, { showDrawingSheet }));
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
		// Centralized here (not scattered across openProjectFolder/
		// navigateToSheet/newProjectFolder/openProjectZip, all of which
		// funnel through this one method) — by the time this runs,
		// currentProject/currentSheetNode already reflect whatever this
		// particular load was for, whether that's a plain single file
		// (both null, renders the fallback) or a step in a project flow.
		this.renderHierarchyPanel();
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

	/**
	 * Opens a whole project folder (Chrome/Edge only — File System Access
	 * API) and loads its root schematic. Sits alongside openKiCadFile/
	 * loadText, which stay exactly as they are for single-file use — this
	 * ADDITIONALLY populates currentProject/fsAdapter/currentSheetNode so
	 * saveProject() and hierarchy navigation (navigateToSheet) have
	 * something to work with. KicadSchematic.loadFromPath (kicad-io) already
	 * recursively loads the ENTIRE sheet hierarchy eagerly — reading from a
	 * local picked folder is fast/free (no network round-trips), so unlike
	 * the gateway-backed web/ Viewer's lazy per-sheet fetch, there's no
	 * reason to defer loading sub-sheets here.
	 */
	async openProjectFolder(): Promise<void> {
		const picker = getDirectoryPicker();
		if (!picker) {
			this.statusBar.setStatus(
				'This browser can\'t open a project folder (needs Chrome or Edge) — use "Open .kicad_sch / .kicad_pcb" for a single file instead.');
			return;
		}
		let dirHandle: FsDirectoryHandle;
		try {
			dirHandle = await picker({ mode: 'readwrite' });
		}
		catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				return;
			}
			this.statusBar.setStatus(
				`Could not open folder — ${ error instanceof Error ? error.message : String(error) }`);
			return;
		}
		try {
			const adapter = new BrowserFsAdapter(dirHandle);
			const proFile = await adapter.findProjectFile();
			if (!proFile) {
				this.statusBar.setStatus(`No .kicad_pro found directly inside "${ dirHandle.name }".`);
				return;
			}
			const project = await KicadProject.openFromProjectRoot(adapter.loadFile, adapter.pathUtils, proFile);
			if (!project.mainSchematic) {
				this.statusBar.setStatus(`"${ proFile }" has no matching .kicad_sch next to it.`);
				return;
			}
			this.currentProject = project;
			this.fsAdapter = adapter;
			this.currentSheetNode = project.mainSchematic;
			this.dom.saveProjectButton.disabled = false;
			const loaded = await this.loadText(project.mainSchematic.data, 'schematic', project.mainSchematic.path);
			if (loaded && this.state.mode === 'view') {
				const sheetCount = this.countSheetsRecursive(project.mainSchematic);
				this.statusBar.setStatus(
					`Loaded project "${ dirHandle.name }" — ${ sheetCount } sheet(s) in hierarchy. Switch to Circuit layout to drag/rotate.`);
			}
		}
		catch (error) {
			this.currentProject = null;
			this.fsAdapter = null;
			this.currentSheetNode = null;
			this.dom.saveProjectButton.disabled = true;
			this.renderHierarchyPanel();
			this.statusBar.setStatus(
				`Could not open project — ${ error instanceof Error ? error.message : String(error) }`);
		}
	}

	protected countSheetsRecursive(node: KicadSchematic): number {
		let count = 1;
		for (const child of node.sheets) {
			count += this.countSheetsRecursive(child);
		}
		return count;
	}

	protected buildSchematicDocInfo(filename: string, options?: { showDrawingSheet?: boolean }): SchematicDocInfo {
		const docInfo: SchematicDocInfo = {
			filename: this.basenameFromPath(filename),
			sheetPath: '/',
			showDrawingSheet: options?.showDrawingSheet ?? true
		};
		if (!this.currentProject?.mainSchematic || !this.currentSheetNode) {
			return docInfo;
		}
		const chain = this.getSheetPathChain(this.currentProject.mainSchematic, this.currentSheetNode);
		const segments = chain.slice(1).map(node => (node.name || node.path || '(unnamed)').trim()).filter(Boolean);
		docInfo.sheetPath = segments.length ? `/${ segments.join('/') }` : '/';
		docInfo.filename = this.basenameFromPath(this.currentSheetNode.path || filename);
		const flattened = this.flattenSheets(this.currentProject.mainSchematic);
		const index = flattened.findIndex(node => node === this.currentSheetNode);
		if (index >= 0) {
			docInfo.sheetNumber = index + 1;
			docInfo.sheetCount = flattened.length;
		}
		return docInfo;
	}

	protected getSheetPathChain(root: KicadSchematic, target: KicadSchematic): KicadSchematic[] {
		if (root === target) {
			return [root];
		}
		for (const child of root.sheets) {
			const childPath = this.getSheetPathChain(child, target);
			if (childPath.length) {
				return [root, ...childPath];
			}
		}
		return [];
	}

	protected flattenSheets(root: KicadSchematic): KicadSchematic[] {
		const list: KicadSchematic[] = [root];
		for (const child of root.sheets) {
			list.push(...this.flattenSheets(child));
		}
		return list;
	}

	protected basenameFromPath(path: string): string {
		return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
	}

	/**
	 * Renders the WHOLE hierarchy (not just the currently-displayed sheet's
	 * direct children — a per-load one-level list, which is what the OLD
	 * edit-mode hierarchy panel used to show via session.currentSheets, and
	 * which is exactly why it used to say "Root schematic" and never update:
	 * a leaf sheet with no sub-sheets of its own has an empty
	 * session.currentSheets regardless of where it sits in the real tree).
	 * Writes the SAME clickable, currentSheetNode-highlighted rows into BOTH
	 * the view-mode Project Hierarchy panel AND the edit-mode Schematic
	 * Hierarchy panel — they're the same tree, just shown in two places, and
	 * must never drift out of sync. This is the ONLY place either panel's
	 * content is written; PropertyPanel.refreshSidebar (called on every
	 * property/selection change, far more often than navigation) no longer
	 * touches hierarchy at all, which is what let the old mechanism
	 * overwrite this with stale content on every unrelated sidebar refresh.
	 */
	protected renderHierarchyPanel(): void {
		this.dom.projectHierarchyEl.replaceChildren();
		this.dom.editHierarchyEl.replaceChildren();
		if (!this.currentProject?.mainSchematic) {
			this.dom.projectHierarchySection.classList.add('hidden');
			this.renderSingleFileHierarchyFallback();
			return;
		}
		this.dom.projectHierarchySection.classList.remove('hidden');
		this.appendHierarchyRow(this.currentProject.mainSchematic, 0, this.dom.projectHierarchyEl);
		this.appendHierarchyRow(this.currentProject.mainSchematic, 0, this.dom.editHierarchyEl);
	}

	/** No project open — falls back to the pre-existing behavior: list
	 *  whichever direct sub-sheet references the ONE currently-loaded file
	 *  has (not navigable, just informational — a loose single file has no
	 *  sibling files to resolve them against). Only the edit-mode panel
	 *  shows this; the view-mode Project Hierarchy panel stays hidden. */
	protected renderSingleFileHierarchyFallback(): void {
		const sheets = this.state.session?.currentSheets ?? [];
		if (!sheets.length) {
			const row = document.createElement('div');
			row.className = 'hierarchy-row';
			row.textContent = '● Root schematic';
			this.dom.editHierarchyEl.appendChild(row);
			return;
		}
		for (const sheet of sheets) {
			const row = document.createElement('div');
			row.className = 'hierarchy-row';
			row.textContent = `● ${ sheet.name } (${ sheet.file })`;
			this.dom.editHierarchyEl.appendChild(row);
		}
	}

	protected appendHierarchyRow(node: KicadSchematic, depth: number, target: HTMLElement): void {
		const row = document.createElement('div');
		row.className = node === this.currentSheetNode ? 'hierarchy-row clickable active' : 'hierarchy-row clickable';
		row.style.paddingLeft = `${ depth * 12 }px`;
		row.textContent = `● ${ node.name || '(root)' }`;
		row.title = node.path;
		row.addEventListener('click', () => { void this.navigateToSheet(node); });
		target.appendChild(row);
		for (const child of node.sheets) {
			this.appendHierarchyRow(child, depth + 1, target);
		}
	}

	/** Navigates to any node already loaded in currentProject's hierarchy —
	 *  used by both the hierarchy panel's click-to-descend and canvas
	 *  double-click on a sheet symbol (see descendIntoSheetAtScreen). */
	async navigateToSheet(node: KicadSchematic): Promise<void> {
		if (!node.rootElement) {
			return;
		}
		this.currentSheetNode = node;
		const loaded = await this.loadText(node.data, 'schematic', node.path || node.name);
		if (loaded) {
			this.statusBar.setStatus(`Viewing sheet "${ node.name }".`);
		}
	}

	/** Double-click-a-sheet-symbol-to-descend, matching real KiCad's own
	 *  gesture (and web/'s ViewerPage.Component.ts identical behavior) —
	 *  only meaningful when a whole project (not a single file) is open,
	 *  since a single loose .kicad_sch has no sibling sheet files to
	 *  resolve. Matches the clicked sheet SYMBOL to a currentSheetNode.sheets
	 *  entry by name (sheet names are the effective identifier KiCad's own
	 *  UI treats as unique among one parent's direct children). */
	async descendIntoSheetAtScreen(screenPos: Vec2): Promise<boolean> {
		if (!this.currentSheetNode || !this.state.session) {
			return false;
		}
		const sheetRef = this.state.session.sheetAtScreen(screenPos);
		if (!sheetRef) {
			return false;
		}
		const node = this.currentSheetNode.sheets.find(s => s.name === sheetRef.name);
		if (!node) {
			return false;
		}
		await this.navigateToSheet(node);
		return true;
	}

	/**
	 * Saves the whole open project back to its folder. Re-parses the LIVE
	 * session text into currentSheetNode first — currentProject's tree was
	 * populated once at open time and the render session holds its own
	 * separate, possibly-since-edited AST for whichever ONE sheet is
	 * currently displayed (this app only ever renders one document at a
	 * time), so without this re-sync, saveAll() would silently write back
	 * the as-opened snapshot instead of the user's edits — the same class of
	 * bug Phase A's KicadSchematic.saveAll() fix targeted, one layer up.
	 */
	async saveProject(): Promise<void> {
		if (!this.currentProject || !this.fsAdapter) {
			this.statusBar.setStatus('No project open to save — use Open Project Folder first.');
			return;
		}
		const session = this.state.session;
		try {
			if (this.currentSheetNode && session) {
				const liveText = this.appState.refreshSchematicText(session);
				if (liveText) {
					this.currentSheetNode.data = liveText;
					this.currentSheetNode.rootElement = new KicadParser().parse(liveText);
				}
			}
			await this.currentProject.saveAll(this.fsAdapter.saveFile);
			this.statusBar.setStatus('Project saved.');
		}
		catch (error) {
			this.statusBar.setStatus(
				`Could not save project — ${ error instanceof Error ? error.message : String(error) }`);
		}
	}

	/** Scaffolds a brand-new blank project (schematic + board + .kicad_pro,
	 *  KicadProject.createNew()/saveAll() from Phase A) into a folder the
	 *  user picks, then opens it the same way openProjectFolder() would. */
	async newProjectFolder(): Promise<void> {
		const picker = getDirectoryPicker();
		if (!picker) {
			this.statusBar.setStatus('This browser can\'t create a project folder (needs Chrome or Edge).');
			return;
		}
		const name = window.prompt('New project name?', 'NewProject')?.trim();
		if (!name) {
			return;
		}
		let dirHandle: FsDirectoryHandle;
		try {
			dirHandle = await picker({ mode: 'readwrite' });
		}
		catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				return;
			}
			this.statusBar.setStatus(
				`Could not open folder — ${ error instanceof Error ? error.message : String(error) }`);
			return;
		}
		try {
			const adapter = new BrowserFsAdapter(dirHandle);
			const project = KicadProject.createNew(name, '', adapter.pathUtils);
			await project.saveAll(adapter.saveFile);
			this.currentProject = project;
			this.fsAdapter = adapter;
			this.currentSheetNode = project.mainSchematic ?? null;
			this.dom.saveProjectButton.disabled = false;
			if (project.mainSchematic) {
				await this.loadText(project.mainSchematic.data, 'schematic', project.mainSchematic.path);
			}
			this.statusBar.setStatus(`Created new project "${ name }" in "${ dirHandle.name }".`);
			this.renderHierarchyPanel();
		}
		catch (error) {
			this.statusBar.setStatus(
				`Could not create project — ${ error instanceof Error ? error.message : String(error) }`);
		}
	}

	/**
	 * Opens a whole project from an uploaded .zip — works in every modern
	 * browser (native DecompressionStream, not File-System-Access-API-gated
	 * like openProjectFolder), so this is the cross-browser project-open
	 * path. Read-only: fsAdapter is deliberately left null (no writable
	 * adapter exists for an in-memory zip), so Save Project stays disabled
	 * for a zip-opened project — matches "load zip... extract", not
	 * "edit and re-download as zip".
	 */
	async openProjectZip(file: File): Promise<void> {
		try {
			const archive = await ZipArchive.open(file);
			const zipAdapter = new ZipFsAdapter(archive);
			const proFile = zipAdapter.findProjectFile();
			if (!proFile) {
				this.statusBar.setStatus(`No .kicad_pro found inside "${ file.name }".`);
				return;
			}
			const project = await KicadProject.openFromProjectRoot(zipAdapter.loadFile, zipAdapter.pathUtils, proFile);
			if (!project.mainSchematic) {
				this.statusBar.setStatus(`"${ proFile }" has no matching .kicad_sch next to it in the zip.`);
				return;
			}
			this.currentProject = project;
			this.fsAdapter = null;
			this.currentSheetNode = project.mainSchematic;
			this.dom.saveProjectButton.disabled = true;
			const loaded = await this.loadText(project.mainSchematic.data, 'schematic', project.mainSchematic.path);
			if (loaded && this.state.mode === 'view') {
				const sheetCount = this.countSheetsRecursive(project.mainSchematic);
				this.statusBar.setStatus(
					`Loaded project "${ file.name }" — ${ sheetCount } sheet(s) in hierarchy (read-only, extracted from zip).`);
			}
		}
		catch (error) {
			this.currentProject = null;
			this.fsAdapter = null;
			this.currentSheetNode = null;
			this.dom.saveProjectButton.disabled = true;
			this.renderHierarchyPanel();
			this.statusBar.setStatus(
				`Could not open zip — ${ error instanceof Error ? error.message : String(error) }`);
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
			void this.loadText(
				this.appState.schematicText, 'schematic', 'circuit-place.kicad_sch', { showDrawingSheet: false })
				.then(loaded => {
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
