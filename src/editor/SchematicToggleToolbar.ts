import type { SchLineMode } from '@kicad-render/KicadRenderSession';

export type SchematicCrosshairMode = 'small' | 'full' | 'diagonal';

export interface SchematicToggleToolbarCallbacks {
	getGridVisible(): boolean;
	setGridVisible(visible: boolean): void;
	getDisplayUnit(): 'mm' | 'mil';
	setDisplayUnit(unit: 'mm' | 'mil'): void;
	getCrosshairMode(): SchematicCrosshairMode;
	cycleCrosshairMode(): void;
	getHiddenPinsVisible(): boolean;
	setHiddenPinsVisible(visible: boolean): void;
	getLineMode(): SchLineMode;
	cycleLineMode(): void;
	getAnnotateAutomatically(): boolean;
	setAnnotateAutomatically(enabled: boolean): void;
	getPropertiesVisible(): boolean;
	setPropertiesVisible(visible: boolean): void;
	getHierarchyVisible(): boolean;
	setHierarchyVisible(visible: boolean): void;
}

const CROSSHAIR_LABELS: Record<SchematicCrosshairMode, string> = {
	small: 'Small Crosshairs',
	full: 'Full-Window Crosshairs',
	diagonal: '45 Degree Crosshairs',
};

const LINE_MODE_LABELS: Record<SchLineMode, string> = {
	free: 'Free Angle',
	'90': '90 Degree',
	'45': '45 Degree',
};

/** Eeschema's left-side display-control toolbar (real KiCad:
 *  `toolbars_sch_editor.cpp`'s `TOOLBAR_LOC::LEFT` — Show Grid / Grid
 *  Overrides / Units / Crosshair / Show Hidden Pins / Line Mode / Annotate
 *  Automatically / Hierarchy Navigator / Properties). Mirrors
 *  `BoardToggleToolbar`'s exact shape — grid/units/crosshair reuse the
 *  SAME session-level mechanisms pcbnew's own toolbar already wired (real
 *  KiCad shares `EDA_UNITS`/`CROSS_HAIR_MODE` across every editor frame),
 *  so no new engine state was needed for those three. Grid Overrides
 *  remains an intentionally disabled stub button in the markup for now —
 *  same "build the shell, wire behavior later" pattern `BoardToggleToolbar`'s
 *  own still-stubbed buttons (Grid Overrides, Line Modes) already
 *  established. */
export class SchematicToggleToolbar {
	protected readonly gridButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="grid"]');
	protected readonly unitsButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="units"]');
	protected readonly crosshairButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="crosshair"]');
	protected readonly hiddenPinsButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="hidden-pins"]');
	protected readonly lineModeButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="line-mode"]');
	protected readonly annotateButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="annotate"]');
	protected readonly propertiesButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="properties"]');
	protected readonly hierarchyButton = document.querySelector<HTMLButtonElement>(
		'#schematic-toggle-panel [data-sch-toggle="hierarchy"]');

	constructor(protected readonly callbacks: SchematicToggleToolbarCallbacks) {
		this.gridButton?.addEventListener('click', () => {
			this.callbacks.setGridVisible(!this.callbacks.getGridVisible());
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
		this.hiddenPinsButton?.addEventListener('click', () => {
			this.callbacks.setHiddenPinsVisible(!this.callbacks.getHiddenPinsVisible());
			this.refresh();
		});
		this.lineModeButton?.addEventListener('click', () => {
			this.callbacks.cycleLineMode();
			this.refresh();
		});
		this.annotateButton?.addEventListener('click', () => {
			this.callbacks.setAnnotateAutomatically(!this.callbacks.getAnnotateAutomatically());
			this.refresh();
		});
		this.propertiesButton?.addEventListener('click', () => {
			this.callbacks.setPropertiesVisible(!this.callbacks.getPropertiesVisible());
			this.refresh();
		});
		this.hierarchyButton?.addEventListener('click', () => {
			this.callbacks.setHierarchyVisible(!this.callbacks.getHierarchyVisible());
			this.refresh();
		});
		this.refresh();
	}

	refresh(): void {
		this.setPressed(this.gridButton, this.callbacks.getGridVisible());
		this.unitsButton?.setAttribute(
			'aria-label', `Units: ${ this.callbacks.getDisplayUnit() === 'mm' ? 'Millimeters' : 'Mils' }`);
		const crosshairMode = this.callbacks.getCrosshairMode();
		this.setPressed(this.crosshairButton, crosshairMode !== 'small');
		this.crosshairButton?.setAttribute('title', `Crosshair Mode: ${ CROSSHAIR_LABELS[crosshairMode] }`);
		this.crosshairButton?.setAttribute('aria-label', `Crosshair Mode: ${ CROSSHAIR_LABELS[crosshairMode] }`);
		this.setPressed(this.hiddenPinsButton, this.callbacks.getHiddenPinsVisible());
		const lineMode = this.callbacks.getLineMode();
		this.setPressed(this.lineModeButton, lineMode !== '90');
		this.lineModeButton?.setAttribute('title', `Line Mode: ${ LINE_MODE_LABELS[lineMode] }`);
		this.lineModeButton?.setAttribute('aria-label', `Line Mode: ${ LINE_MODE_LABELS[lineMode] }`);
		this.setPressed(this.annotateButton, this.callbacks.getAnnotateAutomatically());
		this.setPressed(this.propertiesButton, this.callbacks.getPropertiesVisible());
		this.setPressed(this.hierarchyButton, this.callbacks.getHierarchyVisible());
	}

	protected setPressed(button: HTMLButtonElement | null, pressed: boolean): void {
		button?.classList.toggle('active', pressed);
		button?.setAttribute('aria-pressed', String(pressed));
	}
}
