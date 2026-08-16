export type BoardCrosshairMode = 'small' | 'full' | 'diagonal';
export type BoardItemDisplayMode = 'filled' | 'outline';

export interface BoardToggleToolbarCallbacks {
	getGridVisible(): boolean;
	setGridVisible(visible: boolean): void;
	getPolarCoordinates(): boolean;
	setPolarCoordinates(enabled: boolean): void;
	getDisplayUnit(): 'mm' | 'mil';
	setDisplayUnit(unit: 'mm' | 'mil'): void;
	getCrosshairMode(): BoardCrosshairMode;
	cycleCrosshairMode(): void;
	getRatsnestVisible(): boolean;
	setRatsnestVisible(visible: boolean): void;
	getZoneDisplayMode(): 'filled' | 'outline';
	setZoneDisplayMode(mode: 'filled' | 'outline'): void;
	isHighContrast(): boolean;
	cycleHighContrastMode(): void;
	getHighlightNetEnabled(): boolean;
	setHighlightNetEnabled(enabled: boolean): void;
	getPadDisplayMode(): BoardItemDisplayMode;
	cyclePadDisplayMode(): void;
	getViaDisplayMode(): BoardItemDisplayMode;
	cycleViaDisplayMode(): void;
	getTrackDisplayMode(): BoardItemDisplayMode;
	cycleTrackDisplayMode(): void;
	getAppearanceVisible(): boolean;
	setAppearanceVisible(visible: boolean): void;
	getRouteCornerMode(): '45' | '90' | 'free';
	cycleRouteCornerMode(): void;
}

const CORNER_MODE_LABELS: Record<'45' | '90' | 'free', string> = {
	'45': '45° Corners',
	'90': '90° Corners',
	free: 'Free-Angle Corners',
};

const CROSSHAIR_LABELS: Record<BoardCrosshairMode, string> = {
	small: 'Small Crosshairs',
	full: 'Full-Window Crosshairs',
	diagonal: '45 Degree Crosshairs',
};

/** Pcbnew's left-side display-control toolbar. Only grid visibility is live
 * today; the remaining desktop-KiCad controls are intentionally disabled in
 * the markup until their render behavior is implemented. */
export class BoardToggleToolbar {
	protected readonly gridButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="grid"]');
	protected readonly polarButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="polar"]');
	protected readonly unitsButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="units"]');
	protected readonly crosshairButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="crosshair"]');
	protected readonly ratsnestButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="ratsnest"]');
	protected readonly zoneFillButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="zone-filled"]');
	protected readonly zoneOutlineButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="zone-outline"]');
	protected readonly highContrastButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="high-contrast"]');
	protected readonly highlightNetButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="highlight-net"]');
	protected readonly padDisplayButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="pad-display"]');
	protected readonly viaDisplayButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="via-display"]');
	protected readonly trackDisplayButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="track-display"]');
	protected readonly appearanceButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="appearance"]');
	protected readonly cornerModeButton = document.querySelector<HTMLButtonElement>(
		'#board-toggle-panel [data-board-toggle="corner-mode"]');

	constructor(protected readonly callbacks: BoardToggleToolbarCallbacks) {
		this.gridButton?.addEventListener('click', () => {
			this.callbacks.setGridVisible(!this.callbacks.getGridVisible());
			this.refresh();
		});
		this.polarButton?.addEventListener('click', () => {
			this.callbacks.setPolarCoordinates(!this.callbacks.getPolarCoordinates());
			this.refresh();
		});
		this.unitsButton?.addEventListener('click', () => {
			this.callbacks.setDisplayUnit(this.callbacks.getDisplayUnit() === 'mm' ? 'mil' : 'mm');
			this.refresh();
		});
		this.crosshairButton?.addEventListener('click', () => {
			this.callbacks.cycleCrosshairMode();
			this.refresh();
		});
		this.ratsnestButton?.addEventListener('click', () => {
			this.callbacks.setRatsnestVisible(!this.callbacks.getRatsnestVisible());
			this.refresh();
		});
		this.zoneFillButton?.addEventListener('click', () => {
			this.callbacks.setZoneDisplayMode('filled');
			this.refresh();
		});
		this.zoneOutlineButton?.addEventListener('click', () => {
			this.callbacks.setZoneDisplayMode('outline');
			this.refresh();
		});
		this.highContrastButton?.addEventListener('click', () => {
			this.callbacks.cycleHighContrastMode();
			this.refresh();
		});
		this.highlightNetButton?.addEventListener('click', () => {
			this.callbacks.setHighlightNetEnabled(!this.callbacks.getHighlightNetEnabled());
			this.refresh();
		});
		this.padDisplayButton?.addEventListener('click', () => {
			this.callbacks.cyclePadDisplayMode();
			this.refresh();
		});
		this.viaDisplayButton?.addEventListener('click', () => {
			this.callbacks.cycleViaDisplayMode();
			this.refresh();
		});
		this.trackDisplayButton?.addEventListener('click', () => {
			this.callbacks.cycleTrackDisplayMode();
			this.refresh();
		});
		this.appearanceButton?.addEventListener('click', () => {
			this.callbacks.setAppearanceVisible(!this.callbacks.getAppearanceVisible());
			this.refresh();
		});
		this.cornerModeButton?.addEventListener('click', () => {
			this.callbacks.cycleRouteCornerMode();
			this.refresh();
		});
		this.refresh();
	}

	refresh(): void {
		this.setPressed(this.gridButton, this.callbacks.getGridVisible());
		this.setPressed(this.polarButton, this.callbacks.getPolarCoordinates());
		this.unitsButton?.setAttribute('aria-label', `Units: ${ this.callbacks.getDisplayUnit() === 'mm' ? 'Millimeters' : 'Mils' }`);
		const crosshairMode = this.callbacks.getCrosshairMode();
		this.setPressed(this.crosshairButton, crosshairMode !== 'small');
		this.crosshairButton?.setAttribute('title', `Crosshair Mode: ${ CROSSHAIR_LABELS[crosshairMode] }`);
		this.crosshairButton?.setAttribute('aria-label', `Crosshair Mode: ${ CROSSHAIR_LABELS[crosshairMode] }`);
		this.setPressed(this.ratsnestButton, this.callbacks.getRatsnestVisible());
		const zoneMode = this.callbacks.getZoneDisplayMode();
		this.setPressed(this.zoneFillButton, zoneMode === 'filled');
		this.setPressed(this.zoneOutlineButton, zoneMode === 'outline');
		this.setPressed(this.highContrastButton, this.callbacks.isHighContrast());
		const highlightNetEnabled = this.callbacks.getHighlightNetEnabled();
		this.setPressed(this.highlightNetButton, highlightNetEnabled);
		this.highlightNetButton?.setAttribute('title', highlightNetEnabled
			? 'Highlight Net (click a pad/track/via/zone to select the net)' : 'Highlight Net');
		const padMode = this.callbacks.getPadDisplayMode();
		this.setPressed(this.padDisplayButton, padMode === 'outline');
		this.padDisplayButton?.setAttribute('title', padMode === 'outline' ? 'Sketch Pads (outline only)' : 'Sketch Pads');
		const viaMode = this.callbacks.getViaDisplayMode();
		this.setPressed(this.viaDisplayButton, viaMode === 'outline');
		this.viaDisplayButton?.setAttribute('title', viaMode === 'outline' ? 'Sketch Vias (outline only)' : 'Sketch Vias');
		const trackMode = this.callbacks.getTrackDisplayMode();
		this.setPressed(this.trackDisplayButton, trackMode === 'outline');
		this.trackDisplayButton?.setAttribute('title', trackMode === 'outline' ? 'Sketch Tracks (outline only)' : 'Sketch Tracks');
		this.setPressed(this.appearanceButton, this.callbacks.getAppearanceVisible());
		const cornerMode = this.callbacks.getRouteCornerMode();
		this.setPressed(this.cornerModeButton, cornerMode !== '45');
		this.cornerModeButton?.setAttribute('title', `Route Corner Mode: ${ CORNER_MODE_LABELS[cornerMode] }`);
		this.cornerModeButton?.setAttribute('aria-label', `Route Corner Mode: ${ CORNER_MODE_LABELS[cornerMode] }`);
	}

	protected setPressed(button: HTMLButtonElement | null, pressed: boolean): void {
		button?.classList.toggle('active', pressed);
		button?.setAttribute('aria-pressed', String(pressed));
	}
}
