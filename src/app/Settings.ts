import { FINE_GRID_MM } from '@kicad-layout/Geometry';
import { defaultShortcuts, type ShortcutMap } from './Shortcuts';
import type { SchematicColorOverrides, SchematicThemeId } from './SchematicThemes';

/** Kept as a local literal union, not imported from AppState.ts — this file
 *  is extracted before AppState.ts exists in the ongoing main.ts split, and
 *  the two are structurally identical either way. */
type PowerKind = 'gnd' | 'flag' | 'rail';
export type ThemePreference = 'system' | 'dark' | 'light';
export type ToolbarIconSize = 'small' | 'normal' | 'large';
export type DisplayUnit = 'mm' | 'mil';
export type ZoomSpeed = 'slow' | 'normal' | 'fast';

export interface AppSettings {
	schematicGridSpacingMm: number;
	boardGridSpacingMm: number;
	powerKind: PowerKind;
	schematicGridSnapping: boolean;
	boardGridSnapping: boolean;
	theme: ThemePreference;
	toolbarIconSize: ToolbarIconSize;
	displayUnit: DisplayUnit;
	showStatusBar: boolean;
	zoomSpeed: ZoomSpeed;
	invertZoom: boolean;
	centerAndWarpCursorOnZoom: boolean;
	crosshairCursor: boolean;
	schematicTheme: SchematicThemeId;
	schematicColorOverrides: SchematicColorOverrides;
	shortcuts: ShortcutMap;
}

export const DEFAULT_SETTINGS: AppSettings = {
	schematicGridSpacingMm: FINE_GRID_MM,
	boardGridSpacingMm: 0.5,
	powerKind: 'gnd',
	schematicGridSnapping: true,
	boardGridSnapping: true,
	theme: 'system',
	toolbarIconSize: 'normal',
	displayUnit: 'mm',
	showStatusBar: true,
	zoomSpeed: 'normal',
	invertZoom: false,
	// KiCad common_settings.cpp: input.center_on_zoom defaults to true.
	centerAndWarpCursorOnZoom: true,
	crosshairCursor: false,
	schematicTheme: 'wdark',
	schematicColorOverrides: {},
	shortcuts: defaultShortcuts()
};
const STORAGE_KEY = 'kionline.settings.v2';
const LEGACY_STORAGE_KEY = 'kionline.settings.v1';
const POWER_KINDS: readonly PowerKind[] = ['gnd', 'flag', 'rail'];
const THEMES: readonly ThemePreference[] = ['system', 'dark', 'light'];
const TOOLBAR_ICON_SIZES: readonly ToolbarIconSize[] = ['small', 'normal', 'large'];
const DISPLAY_UNITS: readonly DisplayUnit[] = ['mm', 'mil'];
const ZOOM_SPEEDS: readonly ZoomSpeed[] = ['slow', 'normal', 'fast'];
const SCHEMATIC_THEMES: readonly SchematicThemeId[] = ['wdark', 'kicad-default', 'kicad-classic'];

function colorOverrides(value: unknown): SchematicColorOverrides {
	if (!value || typeof value !== 'object') {
		return {};
	}
	return Object.fromEntries(Object.entries(value).filter(([name, color]) =>
		/^(background|grid|[a-zA-Z]+)$/.test(name) && typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)
	));
}

/**
 * localStorage-backed, not IndexedDB — these are tiny, synchronous,
 * JSON-serializable scalars. SymbolLibraryCache's IndexedDB use is
 * purpose-built for the symbol-library file index (large, needs
 * transactions) and isn't a fit for this.
 */
export class Settings {
	protected values: AppSettings = { ...DEFAULT_SETTINGS };

	/** Call once at bootstrap, before the render session is constructed. */
	load(): AppSettings {
		try {
			const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY) ?? 'null');
			const legacySpacing = Number.isFinite(parsed?.gridSpacingMm) && parsed.gridSpacingMm > 0
				? parsed.gridSpacingMm : undefined;
			const legacySnapping = typeof parsed?.gridSnapping === 'boolean' ? parsed.gridSnapping : undefined;
			this.values = {
				schematicGridSpacingMm: this.validGrid(parsed?.schematicGridSpacingMm, legacySpacing ?? DEFAULT_SETTINGS.schematicGridSpacingMm),
				boardGridSpacingMm: this.validGrid(parsed?.boardGridSpacingMm, legacySpacing ?? DEFAULT_SETTINGS.boardGridSpacingMm),
				powerKind: POWER_KINDS.includes(parsed?.powerKind) ? parsed.powerKind : DEFAULT_SETTINGS.powerKind,
				schematicGridSnapping: typeof parsed?.schematicGridSnapping === 'boolean'
					? parsed.schematicGridSnapping : legacySnapping ?? DEFAULT_SETTINGS.schematicGridSnapping,
				boardGridSnapping: typeof parsed?.boardGridSnapping === 'boolean'
					? parsed.boardGridSnapping : legacySnapping ?? DEFAULT_SETTINGS.boardGridSnapping,
				theme: THEMES.includes(parsed?.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
				toolbarIconSize: TOOLBAR_ICON_SIZES.includes(parsed?.toolbarIconSize)
					? parsed.toolbarIconSize : DEFAULT_SETTINGS.toolbarIconSize,
				displayUnit: DISPLAY_UNITS.includes(parsed?.displayUnit) ? parsed.displayUnit : DEFAULT_SETTINGS.displayUnit,
				showStatusBar: typeof parsed?.showStatusBar === 'boolean'
					? parsed.showStatusBar : DEFAULT_SETTINGS.showStatusBar,
				zoomSpeed: ZOOM_SPEEDS.includes(parsed?.zoomSpeed) ? parsed.zoomSpeed : DEFAULT_SETTINGS.zoomSpeed,
				invertZoom: typeof parsed?.invertZoom === 'boolean' ? parsed.invertZoom : DEFAULT_SETTINGS.invertZoom,
				centerAndWarpCursorOnZoom: typeof parsed?.centerAndWarpCursorOnZoom === 'boolean'
					? parsed.centerAndWarpCursorOnZoom : DEFAULT_SETTINGS.centerAndWarpCursorOnZoom,
				crosshairCursor: typeof parsed?.crosshairCursor === 'boolean'
					? parsed.crosshairCursor : DEFAULT_SETTINGS.crosshairCursor,
				schematicTheme: SCHEMATIC_THEMES.includes(parsed?.schematicTheme)
					? parsed.schematicTheme : DEFAULT_SETTINGS.schematicTheme,
				schematicColorOverrides: colorOverrides(parsed?.schematicColorOverrides),
				shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(parsed?.shortcuts ?? {}) }
			};
		}
		catch {
			this.values = { ...DEFAULT_SETTINGS };
		}
		return this.values;
	}

	get current(): AppSettings {
		return this.values;
	}

	gridSpacingFor(kind: 'schematic' | 'board'): number {
		return kind === 'board' ? this.values.boardGridSpacingMm : this.values.schematicGridSpacingMm;
	}

	snap(n: number, kind: 'schematic' | 'board'): number {
		const spacing = this.gridSpacingFor(kind);
		const snapping = kind === 'board' ? this.values.boardGridSnapping : this.values.schematicGridSnapping;
		return snapping ? Math.round(n / spacing) * spacing : n;
	}

	setGridSpacingMm(kind: 'schematic' | 'board', mm: number): void {
		if (!Number.isFinite(mm) || mm <= 0) {
			return;
		}
		this.values = kind === 'board'
			? { ...this.values, boardGridSpacingMm: mm }
			: { ...this.values, schematicGridSpacingMm: mm };
		this.persist();
	}

	setDisplayUnit(unit: DisplayUnit): void {
		this.values = { ...this.values, displayUnit: unit };
		this.persist();
	}

	setPowerKind(kind: PowerKind): void {
		this.values = { ...this.values, powerKind: kind };
		this.persist();
	}

	replace(values: AppSettings): void {
		this.values = {
			schematicGridSpacingMm: this.validGrid(values.schematicGridSpacingMm, DEFAULT_SETTINGS.schematicGridSpacingMm),
			boardGridSpacingMm: this.validGrid(values.boardGridSpacingMm, DEFAULT_SETTINGS.boardGridSpacingMm),
			powerKind: POWER_KINDS.includes(values.powerKind) ? values.powerKind : DEFAULT_SETTINGS.powerKind,
			schematicGridSnapping: values.schematicGridSnapping,
			boardGridSnapping: values.boardGridSnapping,
			theme: THEMES.includes(values.theme) ? values.theme : DEFAULT_SETTINGS.theme,
			toolbarIconSize: TOOLBAR_ICON_SIZES.includes(values.toolbarIconSize)
				? values.toolbarIconSize : DEFAULT_SETTINGS.toolbarIconSize,
			displayUnit: DISPLAY_UNITS.includes(values.displayUnit) ? values.displayUnit : DEFAULT_SETTINGS.displayUnit,
			showStatusBar: values.showStatusBar,
			zoomSpeed: ZOOM_SPEEDS.includes(values.zoomSpeed) ? values.zoomSpeed : DEFAULT_SETTINGS.zoomSpeed,
			invertZoom: values.invertZoom,
			centerAndWarpCursorOnZoom: values.centerAndWarpCursorOnZoom,
			crosshairCursor: values.crosshairCursor,
			schematicTheme: SCHEMATIC_THEMES.includes(values.schematicTheme)
				? values.schematicTheme : DEFAULT_SETTINGS.schematicTheme,
			schematicColorOverrides: colorOverrides(values.schematicColorOverrides),
			shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...values.shortcuts }
		};
		this.persist();
	}

	reset(): void {
		this.values = { ...DEFAULT_SETTINGS, shortcuts: defaultShortcuts() };
		this.persist();
	}

	protected persist(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
		}
		catch {
			// Best-effort only — a full/disabled localStorage shouldn't break editing.
		}
	}

	protected validGrid(value: unknown, fallback: number): number {
		return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
	}
}
