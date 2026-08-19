export interface BoardAuxToolbarCallbacks {
	/** The current project's raw parsed `.kicad_pro` JSON (same object
	 *  NetClassResolver.buildNetClassRules reads) — track_widths/
	 *  via_dimensions live at board.design_settings.{track_widths,
	 *  via_dimensions}, the same lists Project Setup's Track Widths/Via
	 *  Dimensions pages edit. */
	getProjectRaw(): Record<string, unknown> | null | undefined;

	getTrackWidthIndex(): number;

	setTrackWidthIndex(index: number): void;

	getViaSizeIndex(): number;

	setViaSizeIndex(index: number): void;

	getUseConnectedTrackWidth(): boolean;

	setUseConnectedTrackWidth(value: boolean): void;

	getActiveBoardLayer(): string;

	setActiveBoardLayer(layer: string): void;

	getBoardCopperLayers(): string[];

	getOverrideLocks(): boolean;

	setOverrideLocks(value: boolean): void;

	openLayerPairDialog(): void;

	openProjectSetup(category?: string): void;
}

/** Real KiCad's TOP_AUX toolbar (pcbnew/toolbars_pcb_editor.cpp) — track
 *  width, "use existing track width", via size, active layer, layer pair,
 *  override locks. Grid/zoom deliberately excluded (this app's existing
 *  footer controls cover those; see the harmonic-munching-trinket plan).
 *  Board-mode-only visibility is CSS-driven (`.menu-board` on the row,
 *  the same rule the menu bar's board-only entries already use) — this
 *  class doesn't need to know about document kind at all. */
export class BoardAuxToolbar {
	protected readonly trackWidthEl = document.getElementById('aux-track-width') as HTMLSelectElement;
	protected readonly autoTrackWidthEl = document.getElementById('aux-auto-track-width') as HTMLButtonElement;
	protected readonly viaSizeEl = document.getElementById('aux-via-size') as HTMLSelectElement;
	protected readonly layerSelectEl = document.getElementById('aux-layer-select') as HTMLSelectElement;
	protected readonly layerPairEl = document.getElementById('aux-layer-pair') as HTMLButtonElement;
	protected readonly overrideLocksEl = document.getElementById('aux-override-locks') as HTMLInputElement;

	constructor(protected readonly callbacks: BoardAuxToolbarCallbacks) {
		this.trackWidthEl.addEventListener('change', () => {
			const index = Number(this.trackWidthEl.value);
			if (this.trackWidthEl.value === 'edit') {
				this.callbacks.openProjectSetup('predefined-sizes');
				this.refresh();
				return;
			}
			this.callbacks.setTrackWidthIndex(index);
		});
		this.autoTrackWidthEl.addEventListener('click', () => {
			this.callbacks.setUseConnectedTrackWidth(!this.callbacks.getUseConnectedTrackWidth());
			this.refresh();
		});
		this.viaSizeEl.addEventListener('change', () => {
			const index = Number(this.viaSizeEl.value);
			if (this.viaSizeEl.value === 'edit') {
				this.callbacks.openProjectSetup('predefined-sizes');
				this.refresh();
				return;
			}
			this.callbacks.setViaSizeIndex(index);
		});
		this.layerSelectEl.addEventListener('change', () => {
			this.callbacks.setActiveBoardLayer(this.layerSelectEl.value);
		});
		this.layerPairEl.addEventListener('click', () => this.callbacks.openLayerPairDialog());
		this.overrideLocksEl.addEventListener('change', () => {
			this.callbacks.setOverrideLocks(this.overrideLocksEl.checked);
		});
		this.refresh();
	}

	protected boardDesignSettings(): Record<string, unknown> {
		const raw = this.callbacks.getProjectRaw();
		const board = raw && typeof raw === 'object' ? (raw as { board?: unknown }).board : null;
		const settings = board && typeof board === 'object' ? (board as { design_settings?: unknown }).design_settings :
			null;
		return settings && typeof settings === 'object' ? settings as Record<string, unknown> : {};
	}

	/** Rebuilds every dropdown's option list from current project data and
	 *  re-syncs every control's selected/pressed/checked state — call after
	 *  anything that could have changed the underlying data (project
	 *  loaded/switched, board tab activated, Project Setup edited the
	 *  predefined-sizes lists, a route/via changed the active layer). */
	refresh(): void {
		const settings = this.boardDesignSettings();

		const trackWidths = Array.isArray(settings.track_widths) ? settings.track_widths.map(Number) : [];
		this.trackWidthEl.replaceChildren();
		this.trackWidthEl.appendChild(new Option('Track: use netclass width', '0'));
		trackWidths.forEach((width, i) => {
			this.trackWidthEl.appendChild(new Option(`Track: ${ width.toFixed(2) } mm`, String(i + 1)));
		});
		this.trackWidthEl.appendChild(new Option('── Edit Pre-defined Sizes… ──', 'edit'));
		const trackWidthIndex = this.callbacks.getTrackWidthIndex();
		this.trackWidthEl.value = trackWidthIndex <= trackWidths.length ? String(trackWidthIndex) : '0';

		const viaDimensions = Array.isArray(settings.via_dimensions)
			? settings.via_dimensions as { diameter?: unknown; drill?: unknown }[]
			: [];
		this.viaSizeEl.replaceChildren();
		this.viaSizeEl.appendChild(new Option('Via: use netclass sizes', '0'));
		viaDimensions.forEach((via, i) => {
			const diameter = Number(via.diameter) || 0;
			const drill = Number(via.drill) || 0;
			this.viaSizeEl.appendChild(
				new Option(`Via: ${ diameter.toFixed(2) }/${ drill.toFixed(2) } mm`, String(i + 1)));
		});
		this.viaSizeEl.appendChild(new Option('── Edit Pre-defined Sizes… ──', 'edit'));
		const viaSizeIndex = this.callbacks.getViaSizeIndex();
		this.viaSizeEl.value = viaSizeIndex <= viaDimensions.length ? String(viaSizeIndex) : '0';

		this.autoTrackWidthEl.classList.toggle('active', this.callbacks.getUseConnectedTrackWidth());
		this.autoTrackWidthEl.setAttribute('aria-pressed', String(this.callbacks.getUseConnectedTrackWidth()));

		const layers = this.callbacks.getBoardCopperLayers();
		const activeLayer = this.callbacks.getActiveBoardLayer();
		this.layerSelectEl.replaceChildren(...layers.map(layer => new Option(layer, layer)));
		if (layers.includes(activeLayer)) {
			this.layerSelectEl.value = activeLayer;
		}

		this.overrideLocksEl.checked = this.callbacks.getOverrideLocks();
	}
}
