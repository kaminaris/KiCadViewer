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
import { IndexedDbFsAdapter }                                           from './IndexedDbFsAdapter';
import { ZipArchive }                                                   from './ZipArchive';
import { ZipFsAdapter }                                                 from './ZipFsAdapter';
import { ProjectContext }                                               from './ProjectContext';
import { ProjectRegistry }                                              from './ProjectRegistry';
import type { ProjectStore }                                            from './ProjectStore';
import { SyncedProjectStore }                                           from './SyncedProjectStore';
import { createProjectSyncTransport }                                   from './transport/createProjectSyncTransport';
import type { DocumentKind }                                            from './ActiveDocument';
import type { AppMode }                                                 from './AppState';
import type { AppState }                                                from './AppState';
import type { Settings }                                                from './Settings';
import type { StatusBar }                                               from './StatusBar';
import type { MainDomRefs }                                             from './domRefs';
import { openNewProjectDialog }                                         from '../ui/NewProjectDialog';

/** The subset of ActiveDocument's fields SessionController actually reads/
 * writes — a narrow interface (rather than depending on ActiveDocument
 * directly) so this class doesn't implicitly gain access to editor-gesture
 * fields (editTool, arcPoints, ...) it has no business touching. MainApp.ts
 * passes its one ActiveDocument instance here directly; TypeScript's
 * structural typing accepts it with no adapter code needed. */
export interface SessionControllerState {
	kind: DocumentKind;
	mode: AppMode;
	circuitDragMode: boolean;
	session: KicadRenderSession | null;
	lockedNetlist: LockedNetlist | null;
	placements: CircuitPlacement[];
	placedFragment: string;
	boardGridVisible: boolean;
	boardAppearanceVisible: boolean;
	selectedRef: string | null;
	editSelectedId: string | null;
	rerouting: boolean;
	recipe: CircuitDesignRecipe | null;
	icSymbolText: string;
	/** Which node of the active tab's project hierarchy is CURRENTLY loaded
	 *  into its render session — the render session only ever holds one
	 *  document at a time, so this tracks which tree node that corresponds
	 *  to, both for hierarchy-panel highlighting and so saveProject() knows
	 *  which node to re-sync from the live (possibly edited) session text
	 *  before writing the whole tree back out. */
	currentSheetNode: KicadSchematic | null;
	/** The whole open project (root schematic + full hierarchy + board +
	 *  .kicad_pro) this document's sheet came from — null in plain
	 *  single-file mode. */
	projectContext: ProjectContext | null;
	filename: string;
	readonly canvas: HTMLCanvasElement;
	readonly canvasGl: HTMLCanvasElement;
}

export interface SessionControllerCallbacks {
	closeSymbolChooser(): void;

	resetEditToolState(): void;

	refreshHint(): void;

	refreshSidebar(): void;

	/** Breadcrumb (project / sheet name) + Schematic/PCB view-tabs — the
	 *  chrome that replaced the old View/Circuit/Edit mode switcher. Called
	 *  everywhere refreshHint/refreshSidebar already are, since a project/
	 *  sheet/kind change is exactly when the breadcrumb needs to catch up. */
	refreshBreadcrumb(): void;

	/** Applies the active document's independent grid to both its canvas and
	 * footer selector after a schematic/PCB switch. */
	syncActiveGrid(): void;

	clearLastPointer(): void;

	lockNetlistFromText(text: string, force: boolean): void;

	syncPlacementsFromSession(): number;

	canLockedAutoroute(): boolean;

	relockNetlistFromLiveText(): void;

	restoreSelection(): void;

	ensurePlacement(ref: string): CircuitPlacement | null;

	canAutoroute(): boolean;

	commitReroute(): Promise<void>;

}

/** Owns render-session construction, mode presentation, and document loading.
 * Circuit routing remains in main.ts temporarily because its gesture callers
 * still share the placement and selection variables directly. */
export class SessionController {
	protected projectStore: ProjectStore | null = null;
	protected projectStoreId: string | null = null;

	constructor(
		protected readonly state: SessionControllerState,
		protected readonly appState: AppState,
		protected readonly settings: Settings,
		protected readonly statusBar: StatusBar,
		protected readonly dom: MainDomRefs,
		protected readonly callbacks: SessionControllerCallbacks,
		protected readonly registry: ProjectRegistry = new ProjectRegistry()
	) {
		// The one place Phase 5/6's ProjectStore hooks into the existing edit
		// flow — appState.refreshSchematicText is already the single choke
		// point every mutation call site (ContextMenuController,
		// ClipboardController, PropertiesController, this class's own
		// undo/redo, ...) funnels a committed edit through, so installing the
		// handler here covers all of them without touching any of their call
		// sites. No-ops outside a loaded project (no projectContext/
		// currentSheetNode to key a cache entry against).
		this.appState.setTextCommitHandler(text => {
			const projectContext = this.state.projectContext;
			if (!projectContext) {
				return;
			}
			const path = this.state.kind === 'board'
				? projectContext.project.mainBoard?.path
				: this.state.currentSheetNode?.path;
			if (!path) return;
			if (this.state.kind === 'board' && projectContext.project.mainBoard) {
				// Navigation back to PCB reads this in-memory document before a
				// full save/reparse, so keep its text current on every edit.
				projectContext.project.mainBoard.data = text;
			}
			void this.ensureProjectStore(projectContext.key).saveSheet(path, text);
		});
		// Graceful disconnect on tab close — best-effort (a crash/force-close
		// skips this, which is fine: see SharedWorkerTransport/
		// BroadcastChannelTransport's own doc comments on why a stale peer
		// entry left behind that way isn't a correctness problem).
		window.addEventListener('beforeunload', event => {
			if (this.state.kind === 'schematic' && this.appState.hasUnsavedSchematicChanges) {
				event.preventDefault();
				event.returnValue = '';
			}
			this.projectStore?.dispose();
		});
	}

	/** Lazily constructs (or swaps, disposing the old one) the ProjectStore
	 *  backing whichever project is currently open, and connects it to the
	 *  cross-tab transport so peers on the same project learn this tab is
	 *  here. See the harmonic-munching-trinket plan's Phase 5/6. */
	protected ensureProjectStore(projectId: string): ProjectStore {
		if (!this.projectStore || this.projectStoreId !== projectId) {
			this.projectStore?.dispose();
			const store = new SyncedProjectStore(projectId, createProjectSyncTransport(projectId));
			store.onSheetChanged((sheetPath, text, origin) => {
				if (origin === 'remote') {
					void this.handleRemoteSheetChanged(sheetPath, text);
				}
			});
			store.onSelection(refs => this.handleRemoteSelection(refs));
			store.connect(this.state.kind, this.state.currentSheetNode?.path ?? null);
			this.projectStore = store;
			this.projectStoreId = projectId;
		}
		return this.projectStore;
	}

	/** A peer tab on the same project just saved a change to the sheet this
	 *  page currently has open — pull it in live rather than waiting for a
	 *  reload. Reuses loadText (not a lighter-weight patch) for the same
	 *  reason the rest of this class does: it's the one path that already
	 *  keeps the render session, undo history, and hierarchy panel
	 *  consistent with whatever text it's given. Silently ignored if this
	 *  page has since navigated to a different sheet/kind — an editor with
	 *  a live model-changed hook is still only ever showing one document at
	 *  a time. */
	protected async handleRemoteSheetChanged(sheetPath: string, text: string): Promise<void> {
		if (this.state.kind !== 'schematic' || this.state.currentSheetNode?.path !== sheetPath) {
			return;
		}
		if (this.state.currentSheetNode) {
			this.state.currentSheetNode.data = text;
		}
		await this.loadText(text, 'schematic', sheetPath);
		this.statusBar.setStatus(`Sheet "${ sheetPath }" updated in another tab.`);
	}

	/** Publishes this tab's current selection to peers on the same project —
	 *  the schematic side of the R23 example (see the harmonic-munching-
	 *  trinket plan's Phase 7). No-op outside a loaded project. Empty refs
	 *  is a real, meaningful publish (selection cleared), not skipped. */
	publishSelection(refs: string[]): void {
		if (!this.state.projectContext) {
			return;
		}
		this.ensureProjectStore(this.state.projectContext.key).publishSelection(refs);
	}

	/** A peer tab selected (or cleared selection of) something — the PCB
	 *  side of the R23 example. Boards have no click-select of their own to
	 *  reconcile this against, so this only ever drives the outline cue
	 *  (KicadRenderSession.setFootprintHighlight), never touches
	 *  state.selectedRef/editSelectedId (those are this tab's own
	 *  schematic-editing selection, unrelated). Only the first ref is used
	 *  — the plan's example is a single symbol, and boards have no
	 *  multi-highlight UI to extend to yet. */
	protected handleRemoteSelection(refs: string[]): void {
		if (this.state.kind !== 'board') {
			return;
		}
		this.state.session?.setFootprintHighlight(refs[0] ?? null);
	}

	ensureSession(): KicadRenderSession {
		if (!this.state.session) {
			this.state.session = new KicadRenderSession(this.state.canvas, this.state.canvasGl);
			this.state.session.onError = error => this.statusBar.setStatus(
				error instanceof Error ? error.message : String(error));
			this.state.session.onRender = () => this.statusBar.recordRender();
			this.state.session.setGridSpacing(this.settings.gridSpacingFor(this.state.kind));
			this.state.session.setGridVisible(this.state.kind !== 'board' || this.state.boardGridVisible);
			if (!this.state.session.hasWebGL) {
				// WebGL context creation failed (disabled GPU, headless
				// environment, etc.) — the session already fell back to
				// Canvas2D internally; swap which canvas is visible to match.
				this.state.canvas.classList.remove('hidden');
				this.state.canvasGl.classList.add('hidden');
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

	/** Circuit mode (auto-rewire) is schematic-only — a board-kind tab can't
	 *  reach it, both by disabling the button here and by setMode() itself
	 *  refusing to leave it for one. Edit mode IS reachable for boards (board
	 *  editing — move/rotate/flip footprints, route tracks). Re-run on every
	 *  tab activation (not just on an explicit setMode call) so switching
	 *  straight into a board tab immediately reflects the constraint. */
	refreshModeAvailability(): void {
		(this.dom.modeCircuitBtn as HTMLButtonElement).disabled = this.state.kind === 'board';
	}

	setMode(next: AppMode): void {
		if (next === 'circuit' && this.state.kind === 'board') {
			next = 'view';
		}
		this.refreshModeAvailability();
		this.state.mode = next;
		this.state.circuitDragMode = next === 'circuit';
		this.dom.modeViewBtn.classList.toggle('active', next === 'view');
		this.dom.modeCircuitBtn.classList.toggle('active', next === 'circuit');
		this.dom.modeEditBtn.classList.toggle('active', next === 'edit');
		// view-actions (Open/Save/New/zip) is project management, not a
		// mode-specific toolbar — stays visible regardless of schematic vs.
		// board. edit-actions (Index symbols/Export) and toolPanel (the
		// hand-drawn wire/label/shape tools) are both schematic-only —
		// boards get their own boardToolPanel instead. circuit-actions
		// stays permanently hidden — see index.html's comment.
		const board = this.state.kind === 'board';
		// Menu items are scoped by this attribute (see styles.css's
		// .menu-schematic/.menu-board rule) — it has to live on screenEditorEl,
		// not mainEl, because the top menu bar sits in <header>, a SIBLING of
		// <main>, not a descendant of it. Setting it on mainEl (as this once
		// did) meant the CSS descendant selector never matched anything in the
		// header, so every menu item stayed visible regardless of doc kind.
		this.dom.screenEditorEl.dataset.documentKind = board ? 'board' : 'schematic';
		this.dom.editActions.classList.toggle('hidden', next !== 'edit');
		this.dom.indexSymbolsButton.classList.toggle('hidden', board);
		this.dom.exportEditButton.title = board ? 'Export PCB' : 'Export Schematic';
		this.dom.toolPanel.classList.toggle('hidden', next !== 'edit' || board);
		this.dom.boardTogglePanel.classList.toggle('hidden', !board);
		this.dom.boardToolPanel.classList.toggle('hidden', !board);
		this.dom.boardAppearanceEl.classList.toggle('hidden', !board || !this.state.boardAppearanceVisible);
		this.dom.mainEl.classList.toggle('edit-mode', next === 'edit' && !board);
		this.dom.mainEl.classList.toggle('board-mode', board);
		this.dom.mainEl.classList.toggle('board-appearance-hidden', board && !this.state.boardAppearanceVisible);
		if (next !== 'edit' || board) {
			this.callbacks.closeSymbolChooser();
			this.callbacks.resetEditToolState();
		}

		if (next === 'view') {
			this.statusBar.setStatus(board
				? 'PCB Appearance is ready.'
				: 'Open a .kicad_sch or .kicad_pcb file.');
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
		else if (next === 'edit' && board) {
			this.statusBar.setStatus(this.state.session?.documentTypeLoaded === 'board'
				? 'Board edit mode — drag a footprint to move it.'
				: 'Open a .kicad_pcb to start editing.');
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
		this.callbacks.refreshBreadcrumb();
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
		// No more user-facing View/Circuit/Edit switcher — both kinds load
		// straight into 'edit' now (KiCad's own eeschema/pcbnew have no
		// separate "view" state either — the select tool is just the
		// default/neutral one). Re-run on every load, not just a kind
		// change, so switching sheets never leaves a stale mode behind.
		this.state.kind = kind;
		this.state.filename = filename;
		this.callbacks.syncActiveGrid();
		this.setMode('edit');
		// Must run AFTER setMode(), not before — setMode() is what toggles
		// main's .edit-mode/.board-mode class, which changes the grid's
		// column widths and therefore #stage's actual rendered width.
		// Measuring stage.clientWidth before that class change bakes the
		// PREVIOUS layout's (wrong) width into the WebGL canvas's backing
		// store, which the browser then stretches/squeezes to fit the
		// correct-but-different CSS box — the squished-PCB-view symptom.
		this.resizeCanvas();
		try {
			session.resetUndoHistory();
			this.callbacks.clearLastPointer();
			const showDrawingSheet = options?.showDrawingSheet ?? true;
			if (kind === 'board') {
				this.appState.setBoardText(text);
				await session.loadBoardText(text);
				this.appState.markBoardSaved();
				this.state.placements = [];
				this.state.lockedNetlist = null;
			}
			else {
				this.appState.setSchematicText(text);
				this.state.placedFragment = text;
				this.callbacks.lockNetlistFromText(text, true);
				await session.loadSchematicText(text, this.buildSchematicDocInfo(filename, { showDrawingSheet }));
				this.appState.markSchematicSaved();
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
			if (kind === 'board') {
				this.appState.refreshBoardText(session);
			}
			else {
				this.appState.refreshSchematicText(session);
			}
			return false;
		}
		this.callbacks.refreshHint();
		this.callbacks.refreshSidebar();
		this.callbacks.refreshBreadcrumb();
		if (this.state.projectContext) {
			// Re-announce presence on every navigation within an open project
			// (switching sheets, or Schematic ↔ PCB) — no-ops if this is the
			// very first load (ensureProjectStore's own connect() call just
			// announced the same thing) or on LocalProjectStore (no
			// transport, Phase 5's no-project/scratch case never reaches
			// here anyway since projectContext is null there).
			this.ensureProjectStore(this.state.projectContext.key)
				.updatePresence(this.state.kind, this.state.currentSheetNode?.path ?? null);
		}
		return true;
	}

	async openKiCadFile(file: File): Promise<void> {
		try {
			const text = await file.text();
			const name = file.name.toLowerCase();
			this.statusBar.dbg('openKiCadFile', { name, mode: this.state.mode, bytes: text.length });
			if (name.endsWith('.kicad_pcb')) {
				if (await this.loadText(text, 'board', file.name)) {
					this.statusBar.setStatus(`Loaded board ${ file.name }`);
				}
			}
			else if (await this.loadText(text, 'schematic', file.name)) {
				this.statusBar.setStatus(`Loaded schematic ${ file.name }.`);
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
	 * ADDITIONALLY populates projectContext/currentSheetNode so
	 * saveProject() and hierarchy navigation (navigateToSheet) have
	 * something to work with. KicadSchematic.loadFromPath (kicad-io) already
	 * recursively loads the ENTIRE sheet hierarchy eagerly — reading from a
	 * local picked folder is fast/free (no network round-trips), so unlike
	 * the gateway-backed web/ Viewer's lazy per-sheet fetch, there's no
	 * reason to defer loading sub-sheets here.
	 */
	async openProjectFolder(): Promise<string | null> {
		const picker = getDirectoryPicker();
		if (!picker) {
			this.statusBar.setStatus(
				'This browser can\'t open a project folder (needs Chrome or Edge) — use "Open .kicad_sch / .kicad_pcb" for a single file instead.');
			return null;
		}
		let dirHandle: FsDirectoryHandle;
		try {
			dirHandle = await picker({ mode: 'readwrite' });
		}
		catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				return null;
			}
			this.statusBar.setStatus(
				`Could not open folder — ${ error instanceof Error ? error.message : String(error) }`);
			return null;
		}
		try {
			const adapter = new BrowserFsAdapter(dirHandle);
			const proFile = await adapter.findProjectFile();
			if (!proFile) {
				this.statusBar.setStatus(`No .kicad_pro found directly inside "${ dirHandle.name }".`);
				return null;
			}
			const project = await KicadProject.openFromProjectRoot(adapter.loadFile, adapter.pathUtils, proFile);
			if (!project.mainSchematic) {
				this.statusBar.setStatus(`"${ proFile }" has no matching .kicad_sch next to it.`);
				return null;
			}
			const key = `folder:${ dirHandle.name }:${ proFile }`;
			this.state.projectContext = new ProjectContext(key, project, adapter, dirHandle.name);
			this.state.currentSheetNode = project.mainSchematic;
			this.dom.saveProjectButton.disabled = false;
			const sheetCount = this.countSheetsRecursive(project.mainSchematic);
			void this.registry.upsertProject({
				id: key, name: dirHandle.name, kind: 'folder', dirHandle, proFile, lastOpenedAt: Date.now(), sheetCount
			});
			const loaded = await this.loadText(project.mainSchematic.data, 'schematic', project.mainSchematic.path);
			if (loaded) {
				this.statusBar.setStatus(`Loaded project "${ dirHandle.name }" — ${ sheetCount } sheet(s) in hierarchy.`);
			}
			return key;
		}
		catch (error) {
			this.state.projectContext = null;
			this.state.currentSheetNode = null;
			this.dom.saveProjectButton.disabled = true;
			this.statusBar.setStatus(
				`Could not open project — ${ error instanceof Error ? error.message : String(error) }`);
			return null;
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
		const mainSchematic = this.state.projectContext?.project.mainSchematic;
		if (!mainSchematic || !this.state.currentSheetNode) {
			return docInfo;
		}
		const chain = this.getSheetPathChain(mainSchematic, this.state.currentSheetNode);
		const segments = chain.slice(1).map(node => (node.name || node.path || '(unnamed)').trim()).filter(Boolean);
		docInfo.sheetPath = segments.length ? `/${ segments.join('/') }` : '/';
		docInfo.filename = this.basenameFromPath(this.state.currentSheetNode.path || filename);
		const flattened = this.flattenSheets(mainSchematic);
		const index = flattened.findIndex(node => node === this.state.currentSheetNode);
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

	/** Navigates to any node already loaded in currentProject's hierarchy —
	 *  used by both the hierarchy panel's click-to-descend and canvas
	 *  double-click on a sheet symbol (see descendIntoSheetAtScreen).
	 *  Replaces the current document in place. */
	async navigateToSheet(node: KicadSchematic): Promise<void> {
		if (!node.rootElement) {
			return;
		}
		this.state.currentSheetNode = node;
		const loaded = await this.loadText(node.data, 'schematic', node.path || node.name);
		if (loaded) {
			this.statusBar.setStatus(`Viewing sheet "${ node.name }".`);
		}
	}

	protected findSheetByPath(root: KicadSchematic, sheetPath: string): KicadSchematic | null {
		return this.flattenSheets(root).find(node => node.path === sheetPath) ?? null;
	}

	/**
	 * Entry point for the router's 'editor' screen (see Router.ts /
	 * harmonic-munching-trinket plan Phase 4) — given a projectId from the
	 * URL, ensures state.projectContext matches it (reopening from the
	 * registry when this page doesn't already have it loaded — e.g. a
	 * fresh tab opened via "open in new tab", or a page reload), then loads
	 * the requested view/sheet into the canvas. Folds in what the plan
	 * called reopenProjectFromRegistry() — reopening and resolving a route
	 * are the same operation once the registry is the source of truth for
	 * "which project", so there's no separate method worth keeping apart
	 * from this one.
	 *
	 * Two reopen paths: a 'folder' project needs requestPermission() on its
	 * live dirHandle (a real per-browser-session gesture-gated prompt);
	 * 'imported' and 'browser' ones need nothing at all — both are backed by
	 * the same IndexedDbFsAdapter, which reads straight from IndexedDB (every
	 * tab of this origin already has access to it), so multi-tab support for
	 * either is actually MORE robust than for a folder one.
	 */
	async openFromRegistryRoute(projectId: string, view: DocumentKind, sheetPath: string | null): Promise<void> {
		if (this.state.projectContext?.key !== projectId) {
			const record = await this.registry.getProject(projectId);
			if (!record) {
				this.statusBar.setStatus(
					`Unknown project "${ projectId }" — it may have been opened in a different browser, or its registry entry didn't survive a browser data clear.`);
				return;
			}
			try {
				if (record.kind === 'imported' || record.kind === 'browser') {
					const adapter = new IndexedDbFsAdapter(projectId);
					if (!record.proFile) {
						this.statusBar.setStatus(`"${ record.name }" is missing its project file path — reimport it from Home.`);
						return;
					}
					const project = await KicadProject.openFromProjectRoot(adapter.loadFile, adapter.pathUtils, record.proFile);
					this.state.projectContext = new ProjectContext(projectId, project, adapter, record.name);
					this.state.currentSheetNode = project.mainSchematic ?? null;
					this.dom.saveProjectButton.disabled = false;
					void this.registry.upsertProject({ ...record, lastOpenedAt: Date.now() });
				}
				else if (!record.dirHandle) {
					this.statusBar.setStatus(`"${ record.name }" can't be reopened automatically — open it again from Home.`);
					return;
				}
				else {
					if (record.dirHandle.requestPermission) {
						const permission = await record.dirHandle.requestPermission({ mode: 'readwrite' });
						if (permission !== 'granted') {
							this.statusBar.setStatus(`Permission to "${ record.name }" was not granted.`);
							return;
						}
					}
					const adapter = new BrowserFsAdapter(record.dirHandle);
					const proFile = record.proFile ?? await adapter.findProjectFile();
					if (!proFile) {
						this.statusBar.setStatus(`No .kicad_pro found directly inside "${ record.name }".`);
						return;
					}
					const project = await KicadProject.openFromProjectRoot(adapter.loadFile, adapter.pathUtils, proFile);
					this.state.projectContext = new ProjectContext(projectId, project, adapter, record.name);
					this.state.currentSheetNode = project.mainSchematic ?? null;
					this.dom.saveProjectButton.disabled = false;
					void this.registry.upsertProject({ ...record, lastOpenedAt: Date.now() });
				}
			}
			catch (error) {
				this.statusBar.setStatus(
					`Could not reopen project — ${ error instanceof Error ? error.message : String(error) }`);
				return;
			}
		}
		// Common case: openProjectFolder/newProject/openProjectZip (or a
		// prior call to this same method) already left the canvas showing
		// exactly this route — e.g. Home's "Open Folder" flow immediately
		// navigates the router here right after the picker flow already
		// loaded the root schematic. Reloading it a second time would just
		// reset undo history and re-parse for nothing.
		const mainSchematicPath = this.state.projectContext!.project.mainSchematic?.path;
		const alreadyAtRoute = this.state.kind === view
			&& (view === 'board' || this.state.currentSheetNode?.path === (sheetPath ?? mainSchematicPath));
		if (alreadyAtRoute) {
			return;
		}
		const project = this.state.projectContext!.project;
		if (view === 'board') {
			if (!project.mainBoard) {
				this.statusBar.setStatus(`"${ this.state.projectContext!.rootName }" has no board file.`);
				return;
			}
			if (await this.loadText(project.mainBoard.data, 'board', project.mainBoard.path)) {
				this.statusBar.setStatus(`Loaded board "${ this.state.projectContext!.rootName }".`);
			}
			return;
		}
		if (!project.mainSchematic) {
			this.statusBar.setStatus(`"${ this.state.projectContext!.rootName }" has no schematic file.`);
			return;
		}
		const target = sheetPath ? this.findSheetByPath(project.mainSchematic, sheetPath) : project.mainSchematic;
		if (!target) {
			this.statusBar.setStatus(`Sheet "${ sheetPath }" not found in project.`);
			return;
		}
		await this.navigateToSheet(target);
	}

	/** Double-click-a-sheet-symbol-to-descend, matching real KiCad's own
	 *  gesture (and web/'s ViewerPage.Component.ts identical behavior) —
	 *  only meaningful when a whole project (not a single file) is open,
	 *  since a single loose .kicad_sch has no sibling sheet files to
	 *  resolve. Matches the clicked sheet SYMBOL to a currentSheetNode.sheets
	 *  entry by name (sheet names are the effective identifier KiCad's own
	 *  UI treats as unique among one parent's direct children). */
	async descendIntoSheetAtScreen(screenPos: Vec2): Promise<boolean> {
		if (!this.state.currentSheetNode || !this.state.session) {
			return false;
		}
		const sheetRef = this.state.session.sheetAtScreen(screenPos);
		if (!sheetRef) {
			return false;
		}
		const node = this.state.currentSheetNode.sheets.find(s => s.name === sheetRef.name);
		if (!node) {
			return false;
		}
		await this.navigateToSheet(node);
		return true;
	}

	/**
	 * Saves the whole open project back to its folder. Re-parses the LIVE
	 * session text into currentSheetNode first — the project tree was
	 * populated once at open time and the render session holds its own
	 * separate, possibly-since-edited AST for whichever ONE sheet is
	 * currently displayed, so without this re-sync, saveAll() would
	 * silently write back the as-opened snapshot instead of the user's
	 * edits — the same class of bug Phase A's KicadSchematic.saveAll() fix
	 * targeted, one layer up.
	 *
	 * Single-document seam: with real browser tabs as the multi-view unit
	 * (see harmonic-munching-trinket plan), a project can be open across
	 * SEVERAL tabs at once, each with its own live edits this page has no
	 * way to see. The eventual fix is self-contained to this method: before
	 * `saveAll()`, pull each other tab's live sheet text via the
	 * SharedWorker/IndexedDB sync layer (Phase 6) instead of only
	 * re-syncing this page's own currentSheetNode below.
	 */
	async saveProject(): Promise<void> {
		const projectContext = this.state.projectContext;
		if (!projectContext || !projectContext.fsAdapter) {
			this.statusBar.setStatus('No project open to save — use Open Project Folder first.');
			return;
		}
		try {
			if (this.state.kind === 'board' && projectContext.project.mainBoard && this.state.session) {
				const liveText = this.state.session.getBoardText();
				if (liveText) {
					projectContext.project.mainBoard.data = liveText;
					projectContext.project.mainBoard.rootElement = new KicadParser().parse(liveText);
				}
			}
			else if (this.state.currentSheetNode && this.state.session) {
				const liveText = this.state.session.getSchematicText();
				if (liveText) {
					this.state.currentSheetNode.data = liveText;
					this.state.currentSheetNode.rootElement = new KicadParser().parse(liveText);
				}
			}
			await projectContext.project.saveAll(projectContext.fsAdapter.saveFile);
			if (this.state.kind === 'board') {
				this.appState.markBoardSaved();
			}
			else {
				this.appState.markSchematicSaved();
			}
			this.statusBar.setStatus('Project saved.');
		}
		catch (error) {
			this.statusBar.setStatus(
				`Could not save project — ${ error instanceof Error ? error.message : String(error) }`);
		}
	}

	/**
	 * Scaffolds a brand-new blank project (schematic + board + .kicad_pro,
	 * KicadProject.createNew()/saveAll() from Phase A) entirely in
	 * IndexedDB — the same durable, no-folder-needed storage
	 * openProjectZip() already writes imported projects into (see
	 * IndexedDbFsAdapter's doc comment). No OS folder picker involved: the
	 * name from the dialog is the only input, and "Save Project" already
	 * works against this adapter with no extra wiring.
	 */
	async newProject(): Promise<string | null> {
		const name = await openNewProjectDialog();
		if (!name) {
			return null;
		}
		try {
			const key = `browser:${ crypto.randomUUID() }`;
			const adapter = new IndexedDbFsAdapter(key);
			const project = KicadProject.createNew(name, '', adapter.pathUtils);
			await project.saveAll(adapter.saveFile);
			this.state.projectContext = new ProjectContext(key, project, adapter, name);
			this.state.currentSheetNode = project.mainSchematic ?? null;
			this.dom.saveProjectButton.disabled = false;
			void this.registry.upsertProject({
				id: key, name, kind: 'browser', proFile: `${ name }.kicad_pro`,
				lastOpenedAt: Date.now(), sheetCount: project.mainSchematic ? this.countSheetsRecursive(project.mainSchematic) : undefined
			});
			if (project.mainSchematic) {
				await this.loadText(project.mainSchematic.data, 'schematic', project.mainSchematic.path);
			}
			this.statusBar.setStatus(`Created new project "${ name }".`);
			return key;
		}
		catch (error) {
			this.statusBar.setStatus(
				`Could not create project — ${ error instanceof Error ? error.message : String(error) }`);
			return null;
		}
	}

	/**
	 * Imports a whole project from an uploaded .zip — works in every modern
	 * browser (native DecompressionStream, not File-System-Access-API-gated
	 * like openProjectFolder), so this is the cross-browser project-open
	 * path. The zip itself is only ever read here, once: every .kicad_pro/
	 * .kicad_sch/.kicad_pcb entry gets extracted straight into an
	 * IndexedDbFsAdapter keyed to this project, and everything from this
	 * point on — this initial load included — goes through THAT adapter,
	 * never back through ZipArchive/ZipFsAdapter. That's what makes the
	 * project reopenable from a second browser tab (or a reload) with no
	 * re-upload: the extracted copy in IndexedDB, not the original file, is
	 * the project's actual home now. Writable, unlike the old zip-backed
	 * flow — saveFile persists into the same IndexedDB store, so Save
	 * Project works here too.
	 */
	async openProjectZip(file: File): Promise<string | null> {
		try {
			const archive = await ZipArchive.open(file);
			const zipAdapter = new ZipFsAdapter(archive);
			const proFile = zipAdapter.findProjectFile();
			if (!proFile) {
				this.statusBar.setStatus(`No .kicad_pro found inside "${ file.name }".`);
				return null;
			}
			const key = `imported:${ file.name }:${ file.size }`;
			const fsAdapter = new IndexedDbFsAdapter(key);
			for (const path of archive.listEntries()) {
				if (/\.(kicad_pro|kicad_sch|kicad_pcb)$/i.test(path)) {
					await fsAdapter.saveFile(path, await archive.readText(path));
				}
			}
			const project = await KicadProject.openFromProjectRoot(fsAdapter.loadFile, fsAdapter.pathUtils, proFile);
			if (!project.mainSchematic) {
				this.statusBar.setStatus(`"${ proFile }" has no matching .kicad_sch next to it in the zip.`);
				return null;
			}
			this.state.projectContext = new ProjectContext(key, project, fsAdapter, file.name);
			this.state.currentSheetNode = project.mainSchematic;
			this.dom.saveProjectButton.disabled = false;
			const sheetCount = this.countSheetsRecursive(project.mainSchematic);
			void this.registry.upsertProject({ id: key, name: file.name, kind: 'imported', proFile, lastOpenedAt: Date.now(), sheetCount });
			const loaded = await this.loadText(project.mainSchematic.data, 'schematic', project.mainSchematic.path);
			if (loaded) {
				this.statusBar.setStatus(`Imported project "${ file.name }" — ${ sheetCount } sheet(s) in hierarchy.`);
			}
			return key;
		}
		catch (error) {
			this.state.projectContext = null;
			this.state.currentSheetNode = null;
			this.dom.saveProjectButton.disabled = true;
			this.statusBar.setStatus(
				`Could not import zip — ${ error instanceof Error ? error.message : String(error) }`);
			return null;
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
		if (session.documentTypeLoaded === 'board') {
			this.appState.refreshBoardText(session);
		}
		else {
			this.appState.refreshSchematicText(session);
			this.callbacks.syncPlacementsFromSession();
		}
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
		if (session.documentTypeLoaded === 'board') {
			this.appState.refreshBoardText(session);
		}
		else {
			this.appState.refreshSchematicText(session);
			this.callbacks.syncPlacementsFromSession();
		}
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

	downloadCurrentDocument(): void {
		const session = this.state.session;
		if (!session) {
			this.statusBar.setStatus('No document loaded to export.');
			return;
		}
		const board = session.documentTypeLoaded === 'board';
		const text = board ? session.getBoardText() : session.getSchematicText();
		if (!text.trim()) {
			this.statusBar.setStatus('Nothing to export.');
			return;
		}
		const extension = board ? '.kicad_pcb' : '.kicad_sch';
		const rawName = this.basenameFromPath(this.state.filename || (board ? 'board' : 'schematic'));
		const filename = rawName.toLowerCase().endsWith(extension) ? rawName : `${ rawName.replace(/\.[^.]+$/, '') }${ extension }`;
		const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		link.click();
		URL.revokeObjectURL(url);
		this.statusBar.setStatus(`Exported ${ filename }.`);
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
