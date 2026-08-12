import { FINE_GRID_MM } from '@kicad-layout/Geometry';

/** Kept as a local literal union, not imported from AppState.ts — this file
 *  is extracted before AppState.ts exists in the ongoing main.ts split, and
 *  the two are structurally identical either way. */
type PowerKind = 'gnd' | 'flag' | 'rail';

export interface AppSettings {
	gridSpacingMm: number;
	powerKind: PowerKind;
}

const DEFAULT_SETTINGS: AppSettings = { gridSpacingMm: FINE_GRID_MM, powerKind: 'gnd' };
const STORAGE_KEY = 'kionline.settings.v1';
const POWER_KINDS: readonly PowerKind[] = ['gnd', 'flag', 'rail'];

/**
 * localStorage-backed, not IndexedDB — these are tiny, synchronous,
 * JSON-serializable scalars. SymbolLibraryCache's IndexedDB use is
 * purpose-built for the symbol-library file index (large, needs
 * transactions) and isn't a fit for this.
 */
export class Settings {
	protected values: AppSettings = { ...DEFAULT_SETTINGS };

	/** Call once at bootstrap, before the render session is constructed —
	 *  session construction reads gridSpacingMm at creation time. */
	load(): AppSettings {
		try {
			const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
			this.values = {
				gridSpacingMm: Number.isFinite(parsed?.gridSpacingMm) && parsed.gridSpacingMm > 0
					? parsed.gridSpacingMm : DEFAULT_SETTINGS.gridSpacingMm,
				powerKind: POWER_KINDS.includes(parsed?.powerKind) ? parsed.powerKind : DEFAULT_SETTINGS.powerKind
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

	snap(n: number): number {
		return Math.round(n / this.values.gridSpacingMm) * this.values.gridSpacingMm;
	}

	setGridSpacingMm(mm: number): void {
		if (!Number.isFinite(mm) || mm <= 0) {
			return;
		}
		this.values = { ...this.values, gridSpacingMm: mm };
		this.persist();
	}

	setPowerKind(kind: PowerKind): void {
		this.values = { ...this.values, powerKind: kind };
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
}
