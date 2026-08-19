import { KicadElement }                                                   from '@kicad-io/KicadElement';
import { KicadElementArc }                                                from '@kicad-io/KicadElementArc';
import {
	KicadElementExcludeFromSim, KicadElementInBom, KicadElementInPosFiles, KicadElementOnBoard
}                                                                         from '@kicad-io/KicadElementBoolean';
import { KicadElementCircle }                                             from '@kicad-io/KicadElementCircle';
import { KicadElementBezier }                                             from '@kicad-io/KicadElementPolyline';
import { KicadElementPin }                                                from '@kicad-io/KicadElementPin';
import { KicadElementRectangle }                                          from '@kicad-io/KicadElementStartEnd';
import { KicadElementSymbol }                                             from '@kicad-io/KicadElementSymbol';
import { KicadElementText }                                               from '@kicad-io/KicadElementText';
import { KicadParser }                                                    from '@kicad-io/KicadParser';
import { KicadRenderSession }                                             from '@kicad-render/KicadRenderSession';
import { Vec2 }                                                           from '@kicad-render/math/Vec2';
import { PendingShapeTracker }                                            from '../editor/PendingShape';
import type { CachedSymbolFile, CachedSymbolSummary, SymbolLibraryCache } from '../io/SymbolLibraryCache';
import { buildFilterSearch }                                              from './Dom';
import type { EditorChrome }                                              from './EditorChrome';
import { LibraryTreeList, type ChooserGroup }                             from './LibraryTreeList';
import { fitPreviewCameraToContents }                                     from './PreviewCamera';
import { PropertiesDialog, type KdGridColumn }                            from './PropertiesDialog';
import { PropertyPanel }                                                  from './PropertyPanel';
import { normalizeText, buildScoredGroups, type ScoreField }              from './search/TextScore';

const PIN_ELECTRICAL_TYPE_OPTIONS = [
	'input', 'output', 'bidirectional', 'tri_state', 'passive', 'power_in', 'power_out', 'open_collector',
	'open_emitter', 'no_connect', 'free', 'unspecified'
].map(value => ({ value, label: value }));
const PIN_SHAPE_OPTIONS = [
	'line', 'inverted', 'clock', 'inverted_clock', 'input_low', 'clock_low', 'output_low', 'edge_clock_high',
	'non_logic'
].map(value => ({ value, label: value }));

/** One row in the always-visible Libraries tree: a symbol plus the file it
 *  lives in (a library file is the tree's top-level group). Mirrors
 *  `SymbolChooser`'s `PendingSymbol` shape, but this screen never places a
 *  symbol on a sheet — it loads one for editing. */
type LibrarySymbolRow = { file: CachedSymbolFile; summary: CachedSymbolSummary };

export interface SymbolEditorScreenDom {
	/** `#stage` — used only to read `getBoundingClientRect()` for resize/hit-
	 *  test math, matching PointerController.screenPosFromEvent's own
	 *  stage-not-canvas convention (canvas2d is display:none whenever WebGL
	 *  is active, so its own rect would read all zeros). */
	stage: HTMLElement;
	/** `#symbol-stage-canvas` — a dedicated canvas, NOT the schematic/PCB
	 *  `#canvas-gl` SessionController already owns (see index.html's own
	 *  comment on that element for why). */
	canvas: HTMLCanvasElement;
	/** `#edit-libraries` — the real left-dock Libraries pane body. */
	librariesEl: HTMLElement;
	/** `#edit-properties` — the real left-dock Properties pane body, shared
	 *  with schematic/PCB's own PropertyPanel (whichever mode is active
	 *  last wins; each mode's own render call replaces the pane's children
	 *  wholesale, so this is self-correcting on the next mode switch). */
	propertiesEl: HTMLElement;
	saveButton: HTMLButtonElement;
	revertButton: HTMLButtonElement;
	/** `#symbol-tool-panel` — queried for its `.tool-btn[data-tool]` children. */
	toolPanel: HTMLElement;
	/** `#symbol-text-input` — a dedicated floating input, NOT the schematic/
	 *  board editor's shared `#edit-text-input` (that element already has
	 *  its own permanent listeners bound by `TextInputFlow` at app startup;
	 *  reusing it here would fire both handlers against whatever document
	 *  kind happens to be active). */
	textInput: HTMLInputElement;
	mirrorHButton: HTMLButtonElement;
	mirrorVButton: HTMLButtonElement;
	rotateCcwButton: HTMLButtonElement;
	rotateCwButton: HTMLButtonElement;
	pinTableButton: HTMLButtonElement;
	propertiesButton: HTMLButtonElement;
	unitSelect: HTMLSelectElement;
	/** The SAME `#properties-modal` singleton the schematic/PCB double-click
	 *  Properties dialog already uses (`MainApp.ts`'s module-scope
	 *  `propertiesDialog`) — the Pin Table reuses its generic `grid()`
	 *  primitive rather than building a second modal shell. */
	propertiesDialog: PropertiesDialog;
}

export interface SymbolEditorScreenCallbacks {
	saveFile(fileId: string, text: string): Promise<void>;

	setStatus(message: string): void;
}

/** Mirrors `#symbol-tool-panel`'s `data-tool` values (index.html). Only
 *  'text' and 'text-box' don't do anything yet — they just switch the
 *  active tool and show a status message; wiring them up (they need
 *  inline text-entry UI, unlike every other tool here) is a later phase
 *  (see this class's own doc comment). */
export type SymbolTool =
	'select'
	| 'pin'
	| 'text'
	| 'text-box'
	| 'rect'
	| 'circle'
	| 'arc'
	| 'bezier'
	| 'anchor'
	| 'delete';

const SYMBOL_TOOL_LABELS: Record<Exclude<SymbolTool, 'select' | 'pin' | 'delete'>, string> = {
	text: 'Symbol Text',
	'text-box': 'Symbol Text Box',
	rect: 'Rectangle',
	circle: 'Circle',
	arc: 'Arc',
	bezier: 'Bezier Curve',
	anchor: 'Anchor'
};

/** Symbol editor — mounted into the shared `#screen-editor` shell (see the
 *  harmonic-munching-trinket plan's "Real Symbol Editor" write-up) instead
 *  of owning its own `EditorShell` chrome the way this screen's earlier
 *  incarnation did. Breadcrumb reuses the app's one shared `EditorChrome`
 *  instance; Save/Revert are this screen's own toolbar buttons (symbol-
 *  library-file save is a different action than the project-wide "Save
 *  Project" button schematic/PCB use).
 *
 *  The symbol body renders by embedding it into a throwaway blank
 *  schematic and placing it at the origin via the EXISTING
 *  `addLibrarySymbolFromText` path — the same trick this screen's earlier
 *  small preview canvas already used, just now targeting the real, full-
 *  size stage canvas. This reuses `SchematicPainter`'s real paint/hit-test
 *  code wholesale (no new paint logic), so pins/shapes are genuinely
 *  hit-testable/selectable through the session's normal
 *  `hitTestAtScreen`/`select()` API — click-to-select works for free, and
 *  so does drag-to-move (`translateElementById` already handles any
 *  element with the right geometry accessors — pins included, via its
 *  generic getOrigin/setOrigin branch — with zero new session code) and
 *  delete (`deleteSymbolBodyItem`). Because edits land on THIS session's
 *  own throwaway embedded copy, not directly on `currentSymbol`/
 *  `currentRoot` (the real file's AST), every gesture that mutates the
 *  session ends by calling `syncFromRenderSession()`, which pulls the
 *  embedded definition's current text back out
 *  (`session.getEmbeddedLibrarySymbolText`) and splices it into
 *  `currentRoot` in place of the old copy — the same "AST is the source
 *  of truth, session mirrors it" direction every OTHER mutation in this
 *  class (the property/pin inspector) already uses, just reversed for the
 *  one path where the session is more convenient to mutate first. Drawing
 *  new shapes/pins and a real gesture-union interaction controller
 *  (mirroring `BoardPointerController`'s shape) are still follow-up
 *  phases — this class currently only handles single-item select/drag/
 *  delete via ad hoc mouse/key listeners, not a dedicated controller. */
export class SymbolEditorScreen {
	protected fileId: string | null = null;
	protected currentSymbolName: string | null = null;
	protected readonly cache: SymbolLibraryCache;
	protected readonly callbacks: SymbolEditorScreenCallbacks;
	protected readonly chrome: EditorChrome;
	protected readonly dom: SymbolEditorScreenDom;
	protected readonly librariesFilterEl: HTMLInputElement;
	protected readonly librariesListEl: HTMLDivElement;
	/** Same LibraryTreeList class SymbolChooser's modal uses for its own row
	 *  list — see that file's doc comment on why this is a shared instance
	 *  shape, not a lookalike rebuild. Groups here are library FILES rather
	 *  than nickname strings, since this screen has no separate lib-table
	 *  concept, but the grouping/rendering contract is identical. */
	protected readonly librariesTree: LibraryTreeList<LibrarySymbolRow>;
	protected libraryFiles: CachedSymbolFile[] = [];
	/** Same DOM primitive class the schematic/PCB sidebar's Properties pane
	 *  uses (`.property-section`/`.property-row`/etc.) — reused directly so
	 *  this pane has the same look & feel as the rest of the app instead of
	 *  its own hand-rolled card styling. The undo-target argument is unused
	 *  here (this screen doesn't wire `refreshUndoStack`/`refreshSidebar` —
	 *  see this class's own doc comment on the Undo Stack pane still being
	 *  schematic-owned), so `propertiesEl` doubles as a harmless placeholder. */
	protected readonly propertyPanel: PropertyPanel;

	protected session: KicadRenderSession | null = null;
	protected resizeObserver: ResizeObserver;
	protected previewRequestId = 0;
	protected initialText = '';
	protected currentSourceText = '';
	protected currentFileLabel = 'Symbol library';
	protected currentRoot: KicadElement | null = null;
	protected currentSymbol: KicadElementSymbol | null = null;
	protected selectedPin: KicadElementPin | null = null;
	protected selectedPaintId: string | null = null;
	protected dragGesture: { paintId: string; lastScreen: Vec2 } | null = null;
	protected activeTool: SymbolTool = 'select';
	protected readonly toolButtons: HTMLButtonElement[];
	protected readonly pendingShape = new PendingShapeTracker();
	protected textAnchor: Vec2 | null = null;

	constructor(
		dom: SymbolEditorScreenDom, chrome: EditorChrome, cache: SymbolLibraryCache,
		callbacks: SymbolEditorScreenCallbacks
	) {
		this.dom = dom;
		this.chrome = chrome;
		this.cache = cache;
		this.callbacks = callbacks;

		// No inner section title/card here — `#edit-libraries-pane`'s own
		// `<header>Libraries</header>` (index.html) is already the pane's
		// title; a second "Libraries" label plus a bordered wrapper card
		// around the search+tree was pure duplication (user-reported).
		const librarySearch = buildFilterSearch('Filter symbols…');
		this.librariesFilterEl = librarySearch.input;
		this.librariesListEl = document.createElement('div');
		this.librariesListEl.className = 'symbol-chooser-list';
		this.dom.librariesEl.replaceChildren(librarySearch.root, this.librariesListEl);
		this.librariesTree = new LibraryTreeList<LibrarySymbolRow>(this.librariesListEl, {
			itemKey: row => `${ row.file.id }::${ row.summary.name }`,
			itemName: row => row.summary.name,
			rowDescription: row => row.summary.description || '',
			emptyMessage: hasAnyRows => hasAnyRows ? 'No matching symbols' : 'No symbol library file is indexed yet.',
			onSelect: row => { void this.selectLibraryRow(row); }
		});
		this.librariesFilterEl.addEventListener('input', () => this.renderLibraryTree());

		this.propertyPanel = new PropertyPanel(this.dom.propertiesEl, this.dom.propertiesEl);

		this.dom.saveButton.addEventListener('click', () => { void this.save(); });
		this.dom.revertButton.addEventListener('click', () => this.revert());
		this.dom.mirrorHButton.addEventListener('click', () => this.mirrorSelected('horizontal'));
		this.dom.mirrorVButton.addEventListener('click', () => this.mirrorSelected('vertical'));
		this.dom.rotateCcwButton.addEventListener('click', () => this.rotateSelected(1));
		this.dom.rotateCwButton.addEventListener('click', () => this.rotateSelected(-1));
		this.dom.pinTableButton.addEventListener('click', () => this.openPinTable());
		this.dom.propertiesButton.addEventListener('click', () => this.focusBasicProperties());
		this.dom.canvas.addEventListener('mousedown', event => this.onCanvasMouseDown(event));
		window.addEventListener('mousemove', event => this.onWindowMouseMove(event));
		window.addEventListener('mouseup', () => this.onWindowMouseUp());
		window.addEventListener('keydown', event => this.onWindowKeyDown(event));
		this.dom.textInput.addEventListener('keydown', event => this.onTextInputKeyDown(event));
		this.dom.textInput.addEventListener('blur', () => this.commitTextInput());
		this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObserver.observe(this.dom.stage);

		this.toolButtons = Array.from(this.dom.toolPanel.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]'));
		for (const button of this.toolButtons) {
			const tool = button.dataset.tool as SymbolTool;
			button.addEventListener('click', () => this.setActiveTool(tool));
		}

		this.setEmptyState();
	}

	get isDirty(): boolean {
		return !!this.fileId && this.normalizeEditorText(this.currentSourceText) !== this.normalizeEditorText(
			this.initialText);
	}

	protected normalizeEditorText(text: string): string {
		return text.replace(/\r\n/g, '\n');
	}

	async open(fileId: string | null): Promise<void> {
		const files = (await this.cache.getFiles()).sort(
			(a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name));
		this.libraryFiles = files;
		if (!files.length) {
			this.fileId = null;
			this.setEmptyState();
			return;
		}
		const file = fileId ? files.find(item => item.id === fileId) ?? files[0] : files[0];
		await this.loadFile(file.id);
	}

	/** `preferredSymbolName` lets the Libraries tree open a SPECIFIC symbol
	 *  in a not-yet-loaded file (clicking any child row, not just the
	 *  file's first symbol) — falls back to the file's primary symbol when
	 *  omitted, matching this method's original file-switch behavior. */
	async loadFile(fileId: string, preferredSymbolName?: string): Promise<void> {
		const files = (await this.cache.getFiles()).sort(
			(a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name));
		this.libraryFiles = files;
		const file = files.find(item => item.id === fileId) ?? files[0];
		if (!file) {
			this.fileId = null;
			this.setEmptyState();
			return;
		}
		this.fileId = file.id;
		this.currentFileLabel = file.relativePath || file.name;
		const sourceText = await this.cache.readCachedFile(file.id);
		this.initialText = sourceText;
		this.currentSourceText = sourceText;
		this.currentRoot = this.parseRootText(sourceText);
		this.currentSymbol = this.currentRoot
			? (preferredSymbolName
				? this.currentRoot.findChildrenByClass(KicadElementSymbol)
					.find(candidate => candidate.symbolName === preferredSymbolName)
				?? this.findPrimarySymbol(this.currentRoot)
				: this.findPrimarySymbol(this.currentRoot))
			: null;
		this.currentSymbolName = this.currentSymbol?.symbolName ?? this.extractSymbolName(sourceText);
		this.selectedPin = null;
		this.chrome.setBreadcrumb(`${ this.currentFileLabel } • Symbol library source`, this.currentSymbolName);
		this.renderLibraryTree();
		this.renderSymbolInspector(this.currentSymbol);
		this.syncDirtyState();
		await this.renderSymbolBody();
	}

	protected async selectLibraryRow(row: LibrarySymbolRow): Promise<void> {
		if (row.file.id !== this.fileId) {
			await this.loadFile(row.file.id, row.summary.name);
			return;
		}
		this.selectSymbolByName(row.summary.name);
	}

	protected selectSymbolByName(name: string): void {
		this.currentSymbolName = name;
		this.currentSymbol = this.currentRoot?.findChildrenByClass(KicadElementSymbol)
			.find(candidate => candidate.symbolName === name) ?? null;
		this.selectedPin = null;
		this.chrome.setBreadcrumb(`${ this.currentFileLabel } • ${ name }`, name);
		this.librariesTree.setSelectedKey(this.fileId ? `${ this.fileId }::${ name }` : null);
		this.renderSymbolInspector(this.currentSymbol);
		void this.renderSymbolBody();
	}

	protected parseRootText(sourceText: string): KicadElement | null {
		try {
			return new KicadParser().parse(sourceText) as KicadElement;
		}
		catch {
			return null;
		}
	}

	protected findPrimarySymbol(root: KicadElement | null): KicadElementSymbol | null {
		if (!root) {
			return null;
		}
		return root.findChildrenByClass(KicadElementSymbol)[0] ?? null;
	}

	protected resizeCanvas(): void {
		if (!this.session) {
			return;
		}
		const rect = this.dom.stage.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.session.resize(Math.max(1, Math.floor(rect.width * dpr)), Math.max(1, Math.floor(rect.height * dpr)));
		this.session.render();
	}

	protected screenPosFromEvent(event: MouseEvent): Vec2 {
		const rect = this.dom.stage.getBoundingClientRect();
		return new Vec2(
			(event.clientX - rect.left) * (this.dom.canvas.width / Math.max(1, rect.width)),
			(event.clientY - rect.top) * (this.dom.canvas.height / Math.max(1, rect.height))
		);
	}

	protected onCanvasMouseDown(event: MouseEvent): void {
		if (!this.session || event.button !== 0) {
			return;
		}
		const screenPos = this.screenPosFromEvent(event);
		if (this.activeTool === 'pin') {
			this.placePinAt(this.session.screenToWorld(screenPos));
			return;
		}
		if (this.activeTool === 'delete') {
			const hit = this.session.hitTestAtScreen(screenPos);
			if (hit && hit.kind !== 'symbol' && this.session.deleteSymbolBodyItem(hit.id)) {
				this.selectedPaintId = null;
				this.selectedPin = null;
				this.session.select(null);
				this.session.render();
				this.syncFromRenderSession();
			}
			return;
		}
		if (this.activeTool === 'anchor') {
			this.anchorAt(this.session.screenToWorld(screenPos));
			return;
		}
		if (this.activeTool === 'rect' || this.activeTool === 'circle') {
			const world = this.session.screenToWorld(screenPos);
			const pending = this.pendingShape.current;
			if (pending.kind === 'anchor') {
				if (this.activeTool === 'rect') {
					this.placeRectAt(pending.start, world);
				}
				else {
					this.placeCircleAt(pending.start, world);
				}
				this.pendingShape.clear();
				this.session.setEditPreview(null);
			}
			else {
				this.pendingShape.set({ kind: 'anchor', start: world });
			}
			return;
		}
		if (this.activeTool === 'arc') {
			const world = this.session.screenToWorld(screenPos);
			const pending = this.pendingShape.current;
			const points = pending.kind === 'arc' ? pending.points : [];
			if (points.length < 2) {
				this.pendingShape.set({ kind: 'arc', points: [...points, world] });
			}
			else {
				const [start, end] = points;
				this.placeArcAt(start!, world, end!);
				this.pendingShape.clear();
				this.session.setEditPreview(null);
			}
			return;
		}
		if (this.activeTool === 'bezier') {
			const world = this.session.screenToWorld(screenPos);
			const pending = this.pendingShape.current;
			const points = pending.kind === 'bezier' ? pending.points : [];
			const nextPoints = [...points, world];
			if (nextPoints.length === 4) {
				this.placeBezierAt(nextPoints);
				this.pendingShape.clear();
				this.session.setEditPreview(null);
			}
			else {
				this.pendingShape.set({ kind: 'bezier', points: nextPoints });
			}
			return;
		}
		if (this.activeTool === 'text') {
			this.showTextInputAt(this.session.screenToWorld(screenPos), event);
			return;
		}
		if (this.activeTool !== 'select') {
			// text-box tool not implemented yet (SchematicPainter never paints
			// text_box elements nested inside a symbol's unit sub-symbols, so
			// there's nothing to reuse the way buildSymText let the Text tool
			// reuse existing paint support — see the plan file) — setActiveTool
			// already told the user via the status bar when they picked it.
			return;
		}
		const hit = this.session.hitTestAtScreen(screenPos);
		this.session.select(hit?.id ?? null);
		this.selectedPaintId = hit?.id ?? null;
		this.session.render();
		// The placed preview instance itself (kind:'symbol') isn't a body
		// item — dragging it would just reposition the throwaway wrapper,
		// not edit anything real. Only individual pins/graphics/text drag.
		if (hit && hit.kind !== 'symbol') {
			this.session.pushUndoSnapshot('Move item');
			this.dragGesture = { paintId: hit.id, lastScreen: screenPos };
		}
		else {
			this.dragGesture = null;
		}
	}

	protected setActiveTool(tool: SymbolTool): void {
		this.activeTool = tool;
		for (const button of this.toolButtons) {
			button.classList.toggle('active', button.dataset.tool === tool);
		}
		this.dragGesture = null;
		this.pendingShape.clear();
		this.hideTextInput();
		this.session?.setEditPreview(null);
		this.session?.render();
		if (tool === 'select') {
			this.callbacks.setStatus('Select items to edit, or drag to move.');
		}
		else if (tool === 'pin') {
			this.callbacks.setStatus('Click to place a pin.');
		}
		else if (tool === 'delete') {
			this.callbacks.setStatus('Click an item to delete it.');
		}
		else if (tool === 'rect') {
			this.callbacks.setStatus('Click to start the rectangle, click again for the opposite corner.');
		}
		else if (tool === 'circle') {
			this.callbacks.setStatus('Click to set the center, click again to set the radius.');
		}
		else if (tool === 'arc') {
			this.callbacks.setStatus('Click to set the start, click again for the end, then click to bulge the arc.');
		}
		else if (tool === 'bezier') {
			this.callbacks.setStatus('Click to place each of the 4 Bezier control points.');
		}
		else if (tool === 'anchor') {
			this.callbacks.setStatus('Click to set the new anchor (origin) point.');
		}
		else if (tool === 'text') {
			this.callbacks.setStatus('Click to place symbol text.');
		}
		else {
			this.callbacks.setStatus(`${ SYMBOL_TOOL_LABELS[tool] } tool isn't implemented yet.`);
		}
	}

	/** Snaps to real KiCad's own default pin grid (50 mil / 1.27 mm) —
	 *  matches how the loaded symbol's own existing pins already sit. */
	protected snapToPinGrid(value: number): number {
		const grid = 1.27;
		return Math.round(value / grid) * grid;
	}

	/** Real KiCad symbol libraries are authored with Y increasing UPWARD;
	 *  the schematic/world space `screenToWorld` returns coordinates in
	 *  (Y increasing DOWNWARD) — see `flippedTransform`'s own doc comment
	 *  in SchematicPainter.ts. Painting a placed instance negates Y to go
	 *  from the symbol's stored local coordinates to world space; our
	 *  placement instance sits at the origin with no rotation/mirror, so
	 *  the instance matrix is identity and negating Y is the WHOLE inverse
	 *  transform needed to go the other way — world click position back to
	 *  the local coordinates a new pin/shape must be stored at. Every
	 *  placeXAt() method below must run its clicked point(s) through this
	 *  before constructing/writing an element, or the shape commits at the
	 *  vertically-mirrored position (silent — it still parses and renders,
	 *  just upside-down relative to where the user clicked; only visible by
	 *  checking a placement at nonzero Y, not Y=0). */
	protected worldToLocal(worldPos: Vec2): Vec2 {
		return new Vec2(worldPos.x, -worldPos.y);
	}

	/** Real KiCad never keeps pins as direct children of the top-level
	 *  `(symbol "Name" ...)` element — they live inside a unit sub-symbol
	 *  (`getLayers()`, named "Name_<unit>_<style>", e.g. "Ammeter_AC_1_1").
	 *  That's also where the renderer/hit-tester look (via the same
	 *  addLibrarySymbolFromText resolution Phase 1's render trick reuses),
	 *  so a pin added straight onto `symbol` shows up in the AST and the
	 *  Properties/pin-list inspector (collectPins walks both) but never
	 *  actually renders or hit-tests on canvas. Prefer the unit that
	 *  already holds pins (the one the user is visibly editing); fall back
	 *  to any unit sub-symbol, then finally the symbol itself for the rare
	 *  legacy/simple case that truly has no unit sub-symbols at all. */
	protected resolvePinHostSymbol(symbol: KicadElementSymbol): KicadElementSymbol {
		const units = symbol.getLayers();
		const withPins = units.find(unit => unit.findChildrenByClass(KicadElementPin).length > 0);
		if (withPins) {
			return withPins;
		}
		const firstRealUnit = units.find(unit =>
			typeof unit.deconstructSymbolName === 'function' && unit.deconstructSymbolName().unit >= 1);
		return firstRealUnit ?? units[0] ?? symbol;
	}

	protected placePinAt(worldPos: Vec2): void {
		if (!this.currentSymbol) {
			return;
		}
		const pin = new KicadElementPin();
		const nextNumber = `${ this.collectPins(this.currentSymbol).length + 1 }`;
		const local = this.worldToLocal(worldPos);
		pin.setPin('~', nextNumber);
		pin.setOrigin(this.snapToPinGrid(local.x), this.snapToPinGrid(local.y), 0);
		pin.setLength(2.54);
		pin.setType('passive', 'line');
		this.resolvePinHostSymbol(this.currentSymbol).addChild(pin);
		this.selectedPin = pin;
		this.refreshTextFromAst();
		this.renderSymbolInspector(this.currentSymbol);
		this.callbacks.setStatus(`Placed pin ${ nextNumber }. Click to place another or Esc to stop.`);
	}

	/** Same reasoning as `resolvePinHostSymbol`, for non-pin body graphics:
	 *  real KiCad keeps a symbol's outline/decoration shapes inside a unit
	 *  sub-symbol too (conventionally the "unit 0" one shared across every
	 *  unit/style, e.g. "Ammeter_AC_0_0"/"Ammeter_AC_0_1" — distinct from
	 *  "Ammeter_AC_1_1" which holds that symbol's pins), never as a direct
	 *  child of the top-level `(symbol "Name" ...)` element. Prefer the unit
	 *  that already has non-pin children; fall back to the "unit 0" shared
	 *  sub-symbol convention, then any unit, then the symbol itself. */
	protected resolveShapeHostSymbol(symbol: KicadElementSymbol): KicadElementSymbol {
		const units = symbol.getLayers();
		const withGraphics = units.find(unit => unit.children.some(child => !(child instanceof KicadElementPin)));
		if (withGraphics) {
			return withGraphics;
		}
		const sharedUnit = units.find(unit =>
			typeof unit.deconstructSymbolName === 'function' && unit.deconstructSymbolName().unit === 0);
		return sharedUnit ?? units[0] ?? symbol;
	}

	protected placeRectAt(anchor: Vec2, cursor: Vec2): void {
		if (!this.currentSymbol) {
			return;
		}
		const a = this.worldToLocal(anchor), c = this.worldToLocal(cursor);
		const rect = new KicadElementRectangle(a.x, a.y, c.x, c.y);
		this.resolveShapeHostSymbol(this.currentSymbol).addChild(rect);
		this.refreshTextFromAst();
		this.renderSymbolInspector(this.currentSymbol);
		this.callbacks.setStatus('Placed rectangle.');
	}

	protected placeCircleAt(center: Vec2, cursor: Vec2): void {
		if (!this.currentSymbol) {
			return;
		}
		// Y negates the same way in both points, so the delta (and thus the
		// radius) is unaffected — converted anyway for the stored center.
		const radius = Math.hypot(cursor.x - center.x, cursor.y - center.y);
		const c = this.worldToLocal(center);
		const circle = new KicadElementCircle(c.x, c.y, radius);
		this.resolveShapeHostSymbol(this.currentSymbol).addChild(circle);
		this.refreshTextFromAst();
		this.renderSymbolInspector(this.currentSymbol);
		this.callbacks.setStatus('Placed circle.');
	}

	/** Click order matches real KiCad's own arc tool: start, end, then the
	 *  mid-bulge — same order `addGraphicArc`'s schematic-body counterpart
	 *  in `KicadRenderSession` uses (see `KicadElementArc.setStartMidEnd`'s
	 *  parameter order, sx/sy, mx/my, ex/ey). */
	protected placeArcAt(start: Vec2, mid: Vec2, end: Vec2): void {
		if (!this.currentSymbol) {
			return;
		}
		const s = this.worldToLocal(start), m = this.worldToLocal(mid), e = this.worldToLocal(end);
		const arc = new KicadElementArc();
		arc.setStartMidEnd(s.x, s.y, m.x, m.y, e.x, e.y);
		this.resolveShapeHostSymbol(this.currentSymbol).addChild(arc);
		this.refreshTextFromAst();
		this.renderSymbolInspector(this.currentSymbol);
		this.callbacks.setStatus('Placed arc.');
	}

	protected placeBezierAt(points: Vec2[]): void {
		if (!this.currentSymbol || points.length !== 4) {
			return;
		}
		const bezier = new KicadElementBezier();
		bezier.setPoints(points.map(point => this.worldToLocal(point)));
		this.resolveShapeHostSymbol(this.currentSymbol).addChild(bezier);
		this.refreshTextFromAst();
		this.renderSymbolInspector(this.currentSymbol);
		this.callbacks.setStatus('Placed Bezier curve.');
	}

	/** Per-element geometry shift, dispatching on whichever geometry
	 *  accessors the element happens to have — the same shape of dispatch
	 *  `KicadRenderSession`'s own (private, paint-id-scoped)
	 *  translateElementGeometry uses, duplicated here rather than reused
	 *  because that method is private to a different module and keyed off
	 *  the render session's scene, whereas the Anchor tool mutates
	 *  `currentSymbol` (the real AST) directly — the same "new content,
	 *  write straight to the AST" pattern every placeXAt method already
	 *  uses. Returns whether the element had a recognized geometry shape;
	 *  callers use that to count how many elements actually moved. */
	protected shiftElementBy(el: any, dx: number, dy: number): boolean {
		if (typeof el.getPoints === 'function' && typeof el.setPoints === 'function') {
			el.setPoints(el.getPoints().map((p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy })));
			return true;
		}
		if (typeof el.getStartMidEnd === 'function' && typeof el.setStartMidEnd === 'function') {
			const { start, mid, end } = el.getStartMidEnd();
			el.setStartMidEnd(start.x + dx, start.y + dy, mid.x + dx, mid.y + dy, end.x + dx, end.y + dy);
			return true;
		}
		if (typeof el.getStartEnd === 'function' && typeof el.setStartEnd === 'function') {
			const { start, end } = el.getStartEnd();
			el.setStartEnd(start.x + dx, start.y + dy, end.x + dx, end.y + dy);
			return true;
		}
		if (typeof el.getCenter === 'function' && typeof el.setCenter === 'function') {
			const c = el.getCenter();
			el.setCenter(c.x + dx, c.y + dy);
			return true;
		}
		if (typeof el.getOrigin === 'function' && typeof el.setOrigin === 'function') {
			const o = el.getOrigin();
			el.setOrigin(o.x + dx, o.y + dy, o.rotation);
			return true;
		}
		return false;
	}

	/** Real KiCad's "Set Anchor" — shifts EVERY pin/shape/property field
	 *  across every unit by whatever delta makes the clicked point the new
	 *  origin (0,0), matching real KiCad's whole-symbol-definition scope
	 *  (not just the currently active unit/style). `shiftChildrenOf` skips
	 *  `KicadElementSymbol` children (unit sub-symbols) so a legacy
	 *  no-unit symbol's own direct pin/shape children and a normal
	 *  symbol's per-unit children are both covered exactly once — never
	 *  double-shifted. */
	protected anchorAt(worldPos: Vec2): void {
		if (!this.currentSymbol) {
			return;
		}
		const local = this.worldToLocal(worldPos);
		const dx = -local.x, dy = -local.y;
		if (dx === 0 && dy === 0) {
			this.callbacks.setStatus('Already the anchor point.');
			return;
		}
		const symbol = this.currentSymbol;
		let moved = 0;
		const shiftChildrenOf = (parent: KicadElementSymbol) => {
			for (const child of parent.children) {
				if (child instanceof KicadElementSymbol) {
					continue;
				}
				if (this.shiftElementBy(child, dx, dy)) {
					moved++;
				}
			}
		};
		shiftChildrenOf(symbol);
		for (const unit of symbol.getLayers()) {
			shiftChildrenOf(unit);
		}
		if (moved > 0) {
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
			this.callbacks.setStatus('Anchor point moved.');
		}
		else {
			this.callbacks.setStatus('Nothing to move.');
		}
	}

	/** Shows the floating `#symbol-text-input` at the clicked screen position
	 *  (positioned the same way `TextInputFlow` positions its own input —
	 *  relative to `#stage`'s own rect, since both canvases share that one
	 *  origin) and remembers the WORLD click position for `commitTextInput`. */
	protected showTextInputAt(worldPos: Vec2, event: MouseEvent): void {
		const rect = this.dom.stage.getBoundingClientRect();
		this.textAnchor = worldPos;
		this.dom.textInput.style.left = `${ event.clientX - rect.left }px`;
		this.dom.textInput.style.top = `${ event.clientY - rect.top }px`;
		this.dom.textInput.value = '';
		this.dom.textInput.classList.remove('hidden');
		this.dom.textInput.focus();
	}

	protected hideTextInput(): void {
		this.dom.textInput.classList.add('hidden');
		this.dom.textInput.value = '';
		this.textAnchor = null;
	}

	protected onTextInputKeyDown(event: KeyboardEvent): void {
		event.stopPropagation();
		if (event.key === 'Enter') {
			event.preventDefault();
			this.commitTextInput();
		}
		else if (event.key === 'Escape') {
			event.preventDefault();
			this.hideTextInput();
		}
	}

	protected commitTextInput(): void {
		const anchor = this.textAnchor, value = this.dom.textInput.value.trim();
		if (!this.currentSymbol || !anchor || !value) {
			this.hideTextInput();
			return;
		}
		const local = this.worldToLocal(anchor);
		const text = new KicadElementText(value);
		text.setOrigin(local.x, local.y, 0);
		this.resolveShapeHostSymbol(this.currentSymbol).addChild(text);
		this.hideTextInput();
		this.refreshTextFromAst();
		this.renderSymbolInspector(this.currentSymbol);
		this.callbacks.setStatus(`Placed text "${ value }". Click to place another or Esc to stop.`);
	}

	protected onWindowMouseMove(event: MouseEvent): void {
		if (!this.session) {
			return;
		}
		if (!this.dragGesture) {
			this.updateShapePreview(event);
			return;
		}
		const screenPos = this.screenPosFromEvent(event);
		const worldNow = this.session.screenToWorld(screenPos);
		const worldLast = this.session.screenToWorld(this.dragGesture.lastScreen);
		const dx = worldNow.x - worldLast.x, dy = worldNow.y - worldLast.y;
		if (dx !== 0 || dy !== 0) {
			this.session.translateElementById(this.dragGesture.paintId, dx, dy);
			// A pin has no stable uuid in this app's kicad-io, so its paint id
			// falls back to a POSITION-DERIVED string (see SchematicPainter.
			// buildPin) — the move above just invalidated the very id that
			// produced it, via the scene rebuild translateElementById's own
			// commitAstMutation() triggers. The cursor is (by construction)
			// sitting on top of the item that just moved there, so re-hit-
			// testing at the same screen point re-resolves its NEW id —
			// without this, every frame after the first would silently no-op
			// against a paint id that no longer exists in the rebuilt scene.
			// Re-selecting keeps the live highlight following the drag too,
			// for the same reason (selectedIds still held the old id).
			const refreshed = this.session.hitTestAtScreen(screenPos);
			if (refreshed) {
				this.dragGesture.paintId = refreshed.id;
				this.selectedPaintId = refreshed.id;
				this.session.select(refreshed.id);
			}
			this.session.render();
		}
		this.dragGesture.lastScreen = screenPos;
	}

	protected onWindowMouseUp(): void {
		if (!this.dragGesture) {
			return;
		}
		this.dragGesture = null;
		this.syncFromRenderSession();
	}

	/** Live rubber-band preview for the rect/circle/arc/bezier tools — reuses
	 *  `KicadRenderSession`'s existing `EditPreviewState`/`drawEditPreview`
	 *  (the same mechanism the schematic canvas's own rect/circle/arc/bezier
	 *  tools use), so this needs no new paint code, just feeding it the
	 *  right state per tool/gesture-progress. */
	protected updateShapePreview(event: MouseEvent): void {
		if (!this.session || this.dom.canvas.classList.contains('hidden')) {
			return;
		}
		const cursor = this.session.screenToWorld(this.screenPosFromEvent(event));
		const pending = this.pendingShape.current;
		if (this.activeTool === 'rect' || this.activeTool === 'circle') {
			this.session.setEditPreview(
				{ kind: this.activeTool, anchor: pending.kind === 'anchor' ? pending.start : null, cursor });
		}
		else if (this.activeTool === 'arc') {
			this.session.setEditPreview({ kind: 'arc', points: pending.kind === 'arc' ? pending.points : [], cursor });
		}
		else if (this.activeTool === 'bezier') {
			this.session.setEditPreview(
				{ kind: 'bezier', points: pending.kind === 'bezier' ? pending.points : [], cursor });
		}
		else {
			return;
		}
		this.session.render();
	}

	protected onWindowKeyDown(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
			return;
		}
		if (this.dom.canvas.classList.contains('hidden')) {
			return;
		}
		if (event.key === 'Escape' && this.activeTool !== 'select') {
			this.setActiveTool('select');
			return;
		}
		if (event.key !== 'Delete' && event.key !== 'Backspace') {
			return;
		}
		if (!this.session || !this.selectedPaintId) {
			return;
		}
		if (this.session.deleteSymbolBodyItem(this.selectedPaintId)) {
			event.preventDefault();
			this.selectedPaintId = null;
			this.selectedPin = null;
			this.session.render();
			this.syncFromRenderSession();
		}
	}

	/** Toolbar Mirror Horizontal/Vertical buttons — real KiCad's `X`/`Y`
	 *  hotkeys for a single selected symbol-body item. Delegates entirely to
	 *  `KicadRenderSession.mirrorSymbolBodyItemById` (same session-first
	 *  mutation pattern as drag/delete/rotate) rather than duplicating any
	 *  geometry math here. */
	protected mirrorSelected(axis: 'horizontal' | 'vertical'): void {
		if (!this.session || !this.selectedPaintId) {
			this.callbacks.setStatus('Select an item to mirror.');
			return;
		}
		const newPaintId = this.session.mirrorSymbolBodyItemById(this.selectedPaintId, axis);
		if (newPaintId) {
			this.selectedPaintId = newPaintId;
			this.session.render();
			this.syncFromRenderSession();
			this.callbacks.setStatus(axis === 'horizontal' ? 'Mirrored horizontally.' : 'Mirrored vertically.');
		}
		else {
			this.callbacks.setStatus('Could not mirror this item.');
		}
	}

	/** Toolbar Rotate CCW/CW buttons — real KiCad's `R`/`Shift+R` hotkeys for
	 *  a single selected symbol-body item. `direction`: 1 = counterclockwise,
	 *  -1 = clockwise. Delegates to `KicadRenderSession.rotateSymbolBodyItemById`
	 *  for the same reason as {@link mirrorSelected}. */
	protected rotateSelected(direction: 1 | -1): void {
		if (!this.session || !this.selectedPaintId) {
			this.callbacks.setStatus('Select an item to rotate.');
			return;
		}
		const newPaintId = this.session.rotateSymbolBodyItemById(this.selectedPaintId, direction);
		if (newPaintId) {
			this.selectedPaintId = newPaintId;
			this.session.render();
			this.syncFromRenderSession();
			this.callbacks.setStatus(direction === 1 ? 'Rotated counterclockwise.' : 'Rotated clockwise.');
		}
		else {
			this.callbacks.setStatus('Could not rotate this item.');
		}
	}

	/** Toolbar "Symbol Properties" button. Real KiCad opens a modal dialog
	 *  here, but this app's sidebar (`renderSymbolInspector`'s Basic
	 *  Properties/Fields/Pin Display/Attributes sections) already exposes
	 *  the identical fields through the SAME `KicadElementSymbol` methods a
	 *  modal would call — building a second, parallel dialog would violate
	 *  this app's "no duplicate constructors" rule for zero new capability.
	 *  Instead this just focuses the sidebar's Name field. */
	protected focusBasicProperties(): void {
		const nameInput = this.dom.propertiesEl.querySelector<HTMLInputElement>('.property-section .property-input');
		if (!nameInput) {
			this.callbacks.setStatus('No symbol selected.');
			return;
		}
		nameInput.scrollIntoView({ block: 'center' });
		nameInput.focus();
		nameInput.select();
	}

	/** Pulls the render session's own (post-edit) copy of the symbol
	 *  definition back into `currentRoot`/`currentSymbol` — the real AST
	 *  loaded from the actual .kicad_sym file — replacing the stale sibling
	 *  in place so save/revert/the property-and-pin inspector keep working
	 *  against the same single source of truth they always have. See this
	 *  class's own doc comment for why the session, not `currentSymbol`, is
	 *  the one mutated first for drag/delete. */
	protected syncFromRenderSession(): void {
		if (!this.session || !this.currentRoot || !this.currentSymbolName) {
			return;
		}
		const updatedText = this.session.getEmbeddedLibrarySymbolText(this.currentSymbolName);
		if (!updatedText) {
			return;
		}
		let updatedSymbol: KicadElementSymbol;
		try {
			updatedSymbol = new KicadParser().parse(updatedText) as KicadElementSymbol;
		}
		catch {
			return;
		}
		const siblings = this.currentRoot.children;
		const idx = siblings.findIndex(
			child => child instanceof KicadElementSymbol && child.symbolName === this.currentSymbolName);
		if (idx === -1) {
			return;
		}
		updatedSymbol.parent = this.currentRoot;
		updatedSymbol.rootLevel = siblings[idx]!.rootLevel;
		siblings[idx] = updatedSymbol;
		this.currentSymbol = updatedSymbol;
		this.currentSourceText = this.currentRoot.write();
		this.syncDirtyState();
		this.renderSymbolInspector(this.currentSymbol);
	}

	protected async renderSymbolBody(): Promise<void> {
		const source = this.currentSourceText;
		const symbolName = this.currentSymbolName;
		if (!source || !symbolName) {
			this.callbacks.setStatus('No symbol selected.');
			return;
		}
		const requestId = ++this.previewRequestId;
		if (!this.session) {
			this.session = new KicadRenderSession(this.dom.canvas, null);
			this.session.setSymbolEditMode(true);
		}
		this.resizeCanvas();
		try {
			const blank = '(kicad_sch (version 20221206) (generator eeschema) (uuid 00000000-0000-0000-0000-000000000000) (paper "A4") (lib_symbols))';
			await this.session.loadSchematicText(blank, { filename: 'symbol-body.kicad_sch', showDrawingSheet: false });
			if (requestId !== this.previewRequestId) {
				return;
			}
			const reference = this.session.addLibrarySymbolFromText(source, symbolName, 0, 0, symbolName);
			if (!reference) {
				throw new Error('Could not render symbol.');
			}
			fitPreviewCameraToContents(this.session);
			this.session.render();
			this.populateUnitSelect();
		}
		catch (error) {
			if (requestId !== this.previewRequestId) {
				return;
			}
			this.callbacks.setStatus(error instanceof Error ? error.message : 'Could not render symbol.');
		}
	}

	/** Fills the "Unit A/B/C..." toolbar dropdown from the loaded symbol's
	 *  `getUnitCount()`. Real per-unit filtering of what's shown/hit-tested
	 *  on canvas is NOT implemented yet — every unit's body renders/edits
	 *  together regardless of the selected option — so this only keeps the
	 *  control from being permanently stuck on a single hardcoded "Unit A"
	 *  for multi-unit parts; it's deliberately not wired to anything else. */
	protected populateUnitSelect(): void {
		const select = this.dom.unitSelect;
		const unitCount = this.currentSymbol?.getUnitCount() ?? 1;
		const previous = select.value;
		select.replaceChildren();
		for (let unit = 1; unit <= unitCount; unit++) {
			const option = document.createElement('option');
			option.value = String(unit);
			option.textContent = `Unit ${ String.fromCharCode(64 + unit) }`;
			select.appendChild(option);
		}
		select.value = select.querySelector(`option[value="${ previous }"]`) ? previous : '1';
		select.disabled = unitCount <= 1;
	}

	protected refreshTextFromAst(): void {
		if (!this.currentRoot) {
			return;
		}
		this.currentSourceText = this.currentRoot.write();
		this.syncDirtyState();
		if (this.currentSymbol) {
			const name = this.currentSymbol.symbolName || 'Symbol';
			this.currentSymbolName = name;
			this.chrome.setBreadcrumb(`${ this.currentFileLabel } • Symbol library source`, name);
		}
		void this.renderSymbolBody();
	}

	/** A property row whose NAME (not just its value) is user-editable, plus
	 *  a remove button — `PropertyPanel.row()` covers every OTHER row in
	 *  this pane (fixed label, editable value) but arbitrary symbol fields
	 *  need both, so this builds directly on the same `.property-row`/
	 *  `.property-label`/`.property-value`/`.property-input` classes
	 *  `PropertyPanel.row()` itself uses, matching a Footprint-field row's
	 *  browse-button pattern (`.property-value-browsable`) for the remove
	 *  button's placement. */
	protected renderFieldRow(section: HTMLElement, symbol: KicadElementSymbol, property: {
		propertyName?: string; propertyValue?: string
	}): void {
		const row = document.createElement('div');
		row.className = 'property-row';
		const nameCell = document.createElement('div');
		nameCell.className = 'property-label';
		const nameInput = document.createElement('input');
		nameInput.className = 'property-input';
		nameInput.type = 'text';
		nameInput.value = property.propertyName ?? '';
		nameCell.append(nameInput);
		const valueCell = document.createElement('div');
		valueCell.className = 'property-value property-value-browsable';
		const valueInput = document.createElement('input');
		valueInput.className = 'property-input';
		valueInput.type = 'text';
		valueInput.value = property.propertyValue ?? '';
		const removeBtn = document.createElement('button');
		removeBtn.type = 'button';
		removeBtn.className = 'property-browse-btn';
		removeBtn.textContent = '×';
		removeBtn.title = 'Remove field';
		removeBtn.addEventListener('click', () => {
			const currentName = property.propertyName ?? '';
			if (currentName) {
				symbol.deleteProperty(currentName);
				this.refreshTextFromAst();
				this.renderSymbolInspector(symbol);
			}
		});
		nameInput.addEventListener('change', () => {
			const currentName = property.propertyName ?? '';
			const nextName = nameInput.value.trim();
			if (!nextName) {
				return;
			}
			if (currentName) {
				symbol.deleteProperty(currentName);
			}
			symbol.setProperty(nextName, valueInput.value);
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
		});
		valueInput.addEventListener('change', () => {
			const name = property.propertyName ?? nameInput.value.trim();
			if (!name) {
				return;
			}
			symbol.setProperty(name, valueInput.value);
			this.refreshTextFromAst();
		});
		valueCell.append(valueInput, removeBtn);
		row.append(nameCell, valueCell);
		section.append(row);
	}

	/** A full-width "+ Add …" action row — same shape real KiCad's Fields
	 *  grid uses, built from the same `.property-row`/`.property-browse-btn`
	 *  classes so it sits visually consistent with the rows around it. */
	protected renderAddRow(section: HTMLElement, label: string, onClick: () => void): void {
		const row = document.createElement('div');
		row.className = 'property-row';
		const spacer = document.createElement('div');
		spacer.className = 'property-label';
		const cell = document.createElement('div');
		cell.className = 'property-value';
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'property-browse-btn';
		btn.textContent = label;
		btn.addEventListener('click', onClick);
		cell.append(btn);
		row.append(spacer, cell);
		section.append(row);
	}

	/** Selecting a pin here (or via canvas click) is the only way to load it
	 *  into the "Pin Properties" section below — deletion stays canvas-only
	 *  (the Delete tool, via `deleteSymbolBodyItem`), matching this pane's
	 *  pre-restyle behavior; this row is a selector, not a mutator. */
	protected renderPinListRow(section: HTMLElement, symbol: KicadElementSymbol, pin: KicadElementPin): void {
		const row = document.createElement('div');
		row.className = 'property-row symbol-editor-pin-row';
		if (this.selectedPin === pin) {
			row.classList.add('is-selected');
		}
		const label = document.createElement('div');
		label.className = 'property-label';
		const pinInfo = pin.getPin();
		label.textContent = `${ pinInfo.number || '?' }${ pinInfo.name ? ` – ${ pinInfo.name }` : '' }`;
		const value = document.createElement('div');
		value.className = 'property-value';
		row.append(label, value);
		row.addEventListener('click', () => {
			this.selectedPin = pin;
			this.renderSymbolInspector(symbol);
		});
		section.append(row);
	}

	protected renderSymbolInspector(symbol: KicadElementSymbol | null): void {
		this.propertyPanel.clear();
		if (!symbol) {
			const basic = this.propertyPanel.section('Basic Properties');
			this.propertyPanel.row(basic, 'Object', 'No symbol selected');
			return;
		}

		const basic = this.propertyPanel.section('Basic Properties');
		this.propertyPanel.row(basic, 'Name', symbol.symbolName ?? '', true, value => {
			const nextName = value.trim() || 'Symbol';
			symbol.setSymbolName(nextName);
			this.currentSymbolName = nextName;
			this.chrome.setBreadcrumb(`${ this.currentFileLabel } • Symbol library source`, nextName);
			this.refreshTextFromAst();
		});
		const descriptionValue = symbol.getPropertyByName('Description')?.propertyValue ?? '';
		this.propertyPanel.row(basic, 'Description', descriptionValue, true, value => {
			symbol.setProperty('Description', value);
			this.refreshTextFromAst();
		});

		const fields = this.propertyPanel.section('Fields');
		for (const property of symbol.getProperties()) {
			this.renderFieldRow(fields, symbol, property);
		}
		this.renderAddRow(fields, '+ Add field', () => {
			const name = `Property_${ symbol.getProperties().length + 1 }`;
			symbol.setProperty(name, '');
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
		});

		// Pin Display + Attributes — same fields/setters real KiCad's Symbol
		// Properties dialog exposes for a placed instance
		// (PropertyDialogRenderers.renderSymbol), reused here rather than
		// duplicated: KicadElementSymbol's togglePinNumbers/togglePinNames/
		// setExcludeFromSim/setOnBoard/setDnp/setInBom/setInPosFiles are the
		// SAME methods, just presented as sidebar rows instead of a modal
		// grid (a deliberately different, already-established primitive set
		// for a deliberately different layout — see PropertyPanel vs
		// PropertiesDialog). "Define as Power Symbol" (real KiCad's
		// `(power)` flag) is NOT implemented yet — kicad-io has no
		// read/write support for it, and guessing at where in the child
		// order KiCad's own parser expects it risks a subtly-wrong file
		// (see this project's own "positional parser" lessons) rather than
		// being verified against real KiCad source first.
		const pinDisplay = this.propertyPanel.section('Pin Display');
		this.propertyPanel.checkbox(pinDisplay, 'Show pin numbers', !symbol.arePinNumbersHidden(), value => {
			symbol.togglePinNumbers(value);
			this.refreshTextFromAst();
		});
		this.propertyPanel.checkbox(pinDisplay, 'Show pin names', !symbol.arePinNameLabelsHidden(), value => {
			symbol.togglePinNames(value);
			this.refreshTextFromAst();
		});
		this.propertyPanel.row(pinDisplay, 'Pin name offset (mm)', `${ symbol.getPinNameOffset() }`, true, value => {
			symbol.setPinNameOffset(Number.parseFloat(value) || 0);
			this.refreshTextFromAst();
		});

		const attributes = this.propertyPanel.section('Attributes');
		this.propertyPanel.checkbox(
			attributes, 'Exclude from simulation', !!symbol.findFirstChildByClass(KicadElementExcludeFromSim)?.value,
			value => {
				symbol.setExcludeFromSim(value);
				this.refreshTextFromAst();
			}
		);
		this.propertyPanel.checkbox(
			attributes, 'Exclude from board', symbol.findFirstChildByClass(KicadElementOnBoard)?.value === false,
			value => {
				symbol.setOnBoard(!value);
				this.refreshTextFromAst();
			}
		);
		this.propertyPanel.checkbox(attributes, 'Do not populate', !!symbol.isDnp(), value => {
			symbol.setDnp(value);
			this.refreshTextFromAst();
		});
		this.propertyPanel.checkbox(
			attributes, 'Exclude from bill of materials',
			symbol.findFirstChildByClass(KicadElementInBom)?.value === false,
			value => {
				symbol.setInBom(!value);
				this.refreshTextFromAst();
			}
		);
		this.propertyPanel.checkbox(
			attributes, 'Exclude from position files',
			symbol.findFirstChildByClass(KicadElementInPosFiles)?.value === false, value => {
				symbol.setInPosFiles(!value);
				this.refreshTextFromAst();
			}
		);

		const pinsSection = this.propertyPanel.section('Pins');
		const pins = this.collectPins(symbol);
		for (const pin of pins) {
			this.renderPinListRow(pinsSection, symbol, pin);
		}
		this.renderAddRow(pinsSection, '+ Add pin', () => {
			const pin = new KicadElementPin();
			const existingPins = this.collectPins(symbol);
			const nextNumber = `${ existingPins.length + 1 }`;
			pin.setPin('PIN', nextNumber);
			pin.setOrigin(0, 0, 0);
			pin.setLength(2.54);
			pin.setType('passive', 'line');
			this.resolvePinHostSymbol(symbol).addChild(pin);
			this.selectedPin = pin;
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
		});
		if (!this.selectedPin || !pins.includes(this.selectedPin)) {
			this.selectedPin = pins[0] ?? null;
		}

		const pinProperties = this.propertyPanel.section('Pin Properties');
		if (!this.selectedPin) {
			this.propertyPanel.row(pinProperties, 'Object', 'No pin selected');
			return;
		}
		const pinInfo = this.selectedPin.getPin();
		const origin = this.selectedPin.getOrigin();
		const typeInfo = this.selectedPin.getType();
		this.propertyPanel.row(pinProperties, 'Number', pinInfo.number, true, value => {
			this.selectedPin!.setPin(this.selectedPin!.getPin().name, value || '1');
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
		});
		this.propertyPanel.row(pinProperties, 'Name', pinInfo.name, true, value => {
			this.selectedPin!.setPin(value, this.selectedPin!.getPin().number || '1');
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
		});
		this.propertyPanel.row(pinProperties, 'Position X (mm)', `${ origin.x }`, true, value => {
			const next = Number.parseFloat(value) || 0;
			this.selectedPin!.setOrigin(next, origin.y, origin.rotation);
			this.refreshTextFromAst();
		});
		this.propertyPanel.row(pinProperties, 'Position Y (mm)', `${ origin.y }`, true, value => {
			const next = Number.parseFloat(value) || 0;
			this.selectedPin!.setOrigin(origin.x, next, origin.rotation);
			this.refreshTextFromAst();
		});
		this.propertyPanel.row(pinProperties, 'Length (mm)', `${ this.selectedPin.getLength() }`, true, value => {
			this.selectedPin!.setLength(Number.parseFloat(value) || 0);
			this.refreshTextFromAst();
		});
		this.propertyPanel.select(
			pinProperties, 'Electrical Type', typeInfo.electricalType, PIN_ELECTRICAL_TYPE_OPTIONS, value => {
				this.selectedPin!.setType(value as any, typeInfo.shape);
				this.refreshTextFromAst();
			});
		this.propertyPanel.select(pinProperties, 'Graphic Style', typeInfo.shape, PIN_SHAPE_OPTIONS, value => {
			this.selectedPin!.setType(typeInfo.electricalType, value as any);
			this.refreshTextFromAst();
		});
		this.propertyPanel.checkbox(pinProperties, 'Hidden', this.selectedPin.isHidden(), value => {
			this.selectedPin!.setHidden(value);
			this.refreshTextFromAst();
		});
	}

	protected collectPins(symbol: KicadElementSymbol): KicadElementPin[] {
		const pins: KicadElementPin[] = [];
		const seen = new Set<string>();
		const walk = (node: KicadElementSymbol) => {
			for (const pin of node.findChildrenByClass(KicadElementPin)) {
				const key = pin.getUuid?.()
					?? `${ pin.getPin().number }-${ pin.getPin().name }-${ pin.getOrigin().x }-${ pin.getOrigin().y }`;
				if (!seen.has(key)) {
					seen.add(key);
					pins.push(pin);
				}
			}
			for (const unit of node.getLayers()) {
				walk(unit);
			}
		};
		walk(symbol);
		return pins;
	}

	/** Real KiCad's "Pin Table" toolbar button — a spreadsheet-style view of
	 *  EVERY pin at once (bulk edit), distinct from the sidebar's Pins
	 *  section (one pin's fields at a time, see `renderSymbolInspector`'s
	 *  "Pin Properties"). Reuses the SAME `#properties-modal` singleton and
	 *  `PropertiesDialog.grid()` primitive the schematic/PCB double-click
	 *  Properties dialogs already use (via `PropertyDialogRenderers`'
	 *  Fields grid) rather than building a second grid/modal implementation. */
	protected openPinTable(): void {
		if (!this.currentSymbol) {
			this.callbacks.setStatus('No symbol selected.');
			return;
		}
		this.renderPinTable(this.currentSymbol);
		this.dom.propertiesDialog.show();
	}

	protected renderPinTable(symbol: KicadElementSymbol): void {
		const dialog = this.dom.propertiesDialog;
		dialog.setTitle(`Pin Table — ${ symbol.symbolName ?? 'Symbol' }`);
		dialog.clear();
		const pins = this.collectPins(symbol);
		const rows = pins.map(pin => {
			const info = pin.getPin();
			const origin = pin.getOrigin();
			const type = pin.getType();
			return {
				Number: info.number,
				Name: info.name,
				ElectricalType: type.electricalType,
				GraphicStyle: type.shape,
				X: `${ origin.x }`,
				Y: `${ origin.y }`,
				Length: `${ pin.getLength() }`,
				Hidden: pin.isHidden()
			};
		});
		const columns: KdGridColumn[] = [
			{ key: 'Number', label: 'Number', type: 'text' },
			{ key: 'Name', label: 'Name', type: 'text' },
			{ key: 'ElectricalType', label: 'Electrical Type', type: 'select', options: PIN_ELECTRICAL_TYPE_OPTIONS },
			{ key: 'GraphicStyle', label: 'Graphic Style', type: 'select', options: PIN_SHAPE_OPTIONS },
			{ key: 'X', label: 'X (mm)', type: 'text' },
			{ key: 'Y', label: 'Y (mm)', type: 'text' },
			{ key: 'Length', label: 'Length (mm)', type: 'text' },
			{ key: 'Hidden', label: 'Hidden', type: 'checkbox' }
		];
		const section = dialog.section(dialog.body, 'Pins');
		dialog.grid(section, columns, rows, {
			onCellChange: (rowIndex, key, value) => {
				const pin = pins[rowIndex];
				if (!pin) {
					return;
				}
				switch (key) {
					case 'Number':
						pin.setPin(pin.getPin().name, String(value) || '1');
						break;
					case 'Name':
						pin.setPin(String(value), pin.getPin().number || '1');
						break;
					case 'ElectricalType':
						pin.setType(value as any, pin.getType().shape);
						break;
					case 'GraphicStyle':
						pin.setType(pin.getType().electricalType, value as any);
						break;
					case 'X': {
						const origin = pin.getOrigin();
						pin.setOrigin(Number.parseFloat(String(value)) || 0, origin.y, origin.rotation);
						break;
					}
					case 'Y': {
						const origin = pin.getOrigin();
						pin.setOrigin(origin.x, Number.parseFloat(String(value)) || 0, origin.rotation);
						break;
					}
					case 'Length':
						pin.setLength(Number.parseFloat(String(value)) || 0);
						break;
					case 'Hidden':
						pin.setHidden(!!value);
						break;
				}
				this.refreshTextFromAst();
				this.renderSymbolInspector(symbol);
				this.renderPinTable(symbol);
			},
			onAddRow: () => {
				const pin = new KicadElementPin();
				const nextNumber = `${ pins.length + 1 }`;
				pin.setPin('PIN', nextNumber);
				pin.setOrigin(0, 0, 0);
				pin.setLength(2.54);
				pin.setType('passive', 'line');
				this.resolvePinHostSymbol(symbol).addChild(pin);
				this.refreshTextFromAst();
				this.renderSymbolInspector(symbol);
				this.renderPinTable(symbol);
			},
			addRowLabel: '+ Add Pin'
		});
	}

	async save(): Promise<boolean> {
		if (!this.fileId) {
			return false;
		}
		const text = this.currentSourceText;
		try {
			await this.callbacks.saveFile(this.fileId, text);
			this.initialText = text;
			this.syncDirtyState();
			this.callbacks.setStatus('Saved');
			return true;
		}
		catch (error) {
			this.callbacks.setStatus(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	revert(): void {
		if (!this.fileId) {
			return;
		}
		this.currentRoot = this.parseRootText(this.initialText);
		this.currentSymbol = this.currentRoot ? this.findPrimarySymbol(this.currentRoot) : null;
		this.currentSourceText = this.initialText;
		this.selectedPin = null;
		this.renderSymbolInspector(this.currentSymbol);
		this.syncDirtyState();
		void this.renderSymbolBody();
	}

	/** Groups = library files, rows = that file's symbols — real KiCad's
	 *  Symbol Editor Libraries tree groups the same way. Rendering itself
	 *  goes through `librariesTree` (LibraryTreeList), the SAME class the
	 *  modal SymbolChooser uses for its own row list, so this pane and that
	 *  modal are genuinely one implementation, not two that merely match
	 *  visually. */
	protected renderLibraryTree(): void {
		const query = this.librariesFilterEl.value;
		const searching = normalizeText(query).length > 0;
		const rows: LibrarySymbolRow[] = this.libraryFiles.flatMap(
			file => file.symbols.map(summary => ({ file, summary })));
		// Groups (library files) are reordered by best-matching symbol while
		// searching, not just the rows within each — same as the modal
		// SymbolChooser (LibraryChooser.buildGroups), via the same shared
		// helper, so this pane and that dialog behave identically rather than
		// this one staying pinned to alphabetical file order during a search.
		const groups: ChooserGroup<LibrarySymbolRow>[] = buildScoredGroups(
			query, rows, row => row.file.relativePath || row.file.name, row => this.librarySymbolScoreFields(row),
			row => row.summary.name
		);
		this.librariesTree.setGroups(
			groups, { searching, hasAnyRows: this.libraryFiles.some(file => file.symbols.length > 0) });
		if (this.fileId && !searching) {
			const activeFile = this.libraryFiles.find(file => file.id === this.fileId);
			if (activeFile) {
				this.librariesTree.expandGroup(activeFile.relativePath || activeFile.name);
			}
		}
		this.librariesTree.setSelectedKey(
			this.fileId && this.currentSymbolName ? `${ this.fileId }::${ this.currentSymbolName }` : null);
	}

	protected librarySymbolScoreFields(row: LibrarySymbolRow): ScoreField[] {
		return [
			{ text: row.summary.name, weight: 8, isName: true },
			{ text: row.summary.keywords, weight: 4, isName: false },
			{ text: row.summary.description, weight: 1, isName: false }
		];
	}

	protected setEmptyState(): void {
		this.fileId = null;
		this.currentSymbolName = null;
		this.initialText = '';
		this.currentSourceText = '';
		this.libraryFiles = [];
		this.renderLibraryTree();
		this.chrome.setBreadcrumb('No symbol library loaded', 'Symbol Editor');
		this.callbacks.setStatus('Idle');
		this.dom.saveButton.disabled = true;
		this.dom.revertButton.disabled = true;
		this.renderSymbolInspector(null);
	}

	protected syncDirtyState(): void {
		const dirty = this.isDirty;
		this.dom.saveButton.disabled = !dirty || !this.fileId;
		this.dom.revertButton.disabled = !dirty || !this.fileId;
		this.callbacks.setStatus(dirty ? 'Unsaved changes' : 'Saved');
	}

	protected extractSymbolName(sourceText: string): string {
		try {
			const root = new KicadParser().parse(sourceText);
			const symbol = root?.children.find(
				child => child instanceof KicadElementSymbol) as KicadElementSymbol | undefined;
			if (symbol?.symbolName) {
				return symbol.symbolName;
			}
		}
		catch {
			// Fall back to the raw-text regex below when parsing fails.
		}
		const match = sourceText.match(/\(symbol\s+"([^"]+)"/);
		return match?.[1] ?? 'Symbol';
	}
}
