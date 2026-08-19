import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { Vec2 }               from '@kicad-render/math/Vec2';
import {
	SymbolLibraryCache,
	type CachedSymbolFile,
	type CachedSymbolSummary
}                             from '../io/SymbolLibraryCache';
import { LibraryChooser, type ChooserGroup } from './LibraryChooser';
import { fitPreviewCameraToContents } from './PreviewCamera';
import { type ScoreField, type ScoredGroupCompareInput } from './search/TextScore';

type PendingSymbol = { file: CachedSymbolFile; summary: CachedSymbolSummary; libId: string };
type PendingUnitState = { libId: string; reference: string; nextUnit: number; totalUnits: number };

export interface SymbolChooserCallbacks {
	getSession(): KicadRenderSession | null;

	refreshSchematicText(session: KicadRenderSession): void;

	setSelectedReference(reference: string | null): void;

	setStatus(message: string): void;

	setEditTool(tool: 'select' | 'place-symbol'): void;
}

/** KiCad-style symbol picker, including preview rendering and virtualized
 *  list handling. It owns all placement state so the canvas editor only
 *  needs to forward a snapped placement point. Shares its modal shell,
 *  search/grouping, virtualized list, MRU, and preview-session lifecycle
 *  with `FootprintChooser` via `LibraryChooser` — see that file's doc
 *  comment. Everything below is this chooser's real difference: the
 *  multi-unit sequential placement flow. */
export class SymbolChooser extends LibraryChooser<PendingSymbol> {
	protected readonly repeatCopiesEl = document.getElementById('symbol-repeat-copies') as HTMLInputElement;
	protected readonly allUnitsEl = document.getElementById('symbol-all-units') as HTMLInputElement;

	protected pendingAnchor: Vec2 | null = null;
	protected pendingUnitState: PendingUnitState | null = null;

	protected static readonly BULK_UNIT_SPACING_MM = 12.7;
	protected static readonly RECENT_STORAGE_KEY = 'kionline-recent-symbol-libids';
	/** Nickname of the app's bundled fallback library — see
	 *  SymbolLibraryCache.ensureDefaultLibrary's doc comment. Used only to
	 *  break library-group sort ties in compareLibraryGroups(), matching
	 *  desktop KiCad's real-world "Device sorts first" behavior. */
	protected static readonly DEVICE_LIBRARY_NICKNAME = 'Device';

	constructor(protected readonly cache: SymbolLibraryCache, protected readonly callbacks: SymbolChooserCallbacks) {
		super({
			modal: 'symbol-chooser-modal',
			title: 'symbol-chooser-title',
			filterPlaceholder: 'Filter symbols…',
			list: 'symbol-chooser-list',
			details: 'symbol-preview-details',
			previewArt: 'symbol-preview-art',
			previewCanvas: 'symbol-preview-canvas',
			previewPlaceholder: 'symbol-preview-placeholder',
			ok: 'symbol-chooser-ok',
			cancel: 'symbol-chooser-cancel',
			close: 'symbol-chooser-close',
		});
		this.cancelEl.addEventListener('click', () => this.cancelPlacement());
		this.closeEl.addEventListener('click', () => this.cancelPlacement());
		this.okEl.addEventListener('click', () => this.confirm());
	}

	get hasPendingSymbol(): boolean { return this.pendingItem !== null; }

	async open(): Promise<void> {
		await this.loadAndShow();
	}

	close(): void {
		this.hideModal();
		this.pendingItem = null;
	}

	clearPlacement(): void {
		this.close();
		this.pendingAnchor = null;
		this.pendingUnitState = null;
	}

	cancelPlacement(): void {
		this.clearPlacement();
		this.callbacks.setEditTool('select');
	}

	/** Called by the canvas when the active place-symbol tool receives a click. */
	placeAt(anchor: Vec2): void {
		if (this.pendingItem) {
			void this.beginPlacement(anchor);
			return;
		}
		this.pendingAnchor = anchor;
		void this.open();
	}

	// --- LibraryChooser hooks ------------------------------------------

	protected async fetchRows(): Promise<PendingSymbol[]> {
		const files = await this.cache.getFiles();
		return files.flatMap(file => file.symbols.map(summary => ({ file, summary, libId: this.libraryId(file, summary) })));
	}

	protected itemKey(item: PendingSymbol): string { return item.libId; }

	protected itemName(item: PendingSymbol): string { return item.summary.name; }

	protected rowDescription(item: PendingSymbol): string {
		return item.summary.description || item.summary.value || item.summary.reference || '';
	}

	protected itemNounPlural(): string { return 'Symbol'; }

	protected recentStorageKey(): string { return SymbolChooser.RECENT_STORAGE_KEY; }

	protected emptyMessage(hasAnyRows: boolean): string {
		return hasAnyRows ? 'No matching symbols' : 'Index a .kicad_sym directory first.';
	}

	protected previewEmptyMessage(): string { return 'Select a symbol to preview'; }

	protected onLoadError(error: unknown): void {
		this.callbacks.setStatus(error instanceof Error ? error.message : String(error));
	}

	protected renderDetails(item: PendingSymbol): void {
		const { summary } = item;
		this.detailsEl.innerHTML = `<div class="detail-title">${ summary.name }</div><div class="detail-muted">${ summary.description
		|| 'No description available.' }</div><br>Reference: ${ summary.reference
		|| 'U' }\nUnits: ${ summary.units }\nKeywords: ${ summary.keywords
		|| '—' }\nLibrary: ${ item.file.relativePath }`;
	}

	protected clearDetails(): void {
		this.detailsEl.textContent = '';
	}

	/** Field weights mirror LIB_SYMBOL::cacheSearchTerms (lib_symbol.cpp):
	 *  lib_id 16, name 8, library nickname 4, keywords 4, Value 4,
	 *  description 1 — fed into the shared eeschema-parity scorer (see
	 *  search/TextScore.ts's own doc comment for the algorithm itself). */
	protected scoreFields(item: PendingSymbol): ScoreField[] {
		return [
			{ text: item.libId, weight: 16, isName: true },
			{ text: item.summary.name, weight: 8, isName: true },
			{ text: this.libraryNickname(item), weight: 4, isName: false },
			{ text: item.summary.keywords, weight: 4, isName: false },
			{ text: item.summary.value, weight: 4, isName: false },
			{ text: item.summary.description, weight: 1, isName: false },
		];
	}

	protected libraryGroupKey(item: PendingSymbol): string { return this.libraryNickname(item); }

	/** Real KiCad's "-- Already Placed --" pseudo-group (sch_drawing_tools.cpp):
	 *  every distinct lib_id already placed on the CURRENT sheet (this app has
	 *  no cheap way to walk the whole hierarchy from here — see
	 *  KicadRenderSession.listSymbolPoses's own doc comment), resolved back to
	 *  a PendingSymbol only when that library is actually indexed. */
	protected override extraGroups(query: string): ChooserGroup<PendingSymbol>[] {
		const placedRows = this.scoreAndSort(query, this.alreadyPlacedRows());
		return placedRows.length ? [{ label: '-- Already Placed --', rows: placedRows }] : [];
	}

	/**
	 * Library group ORDER, not just the symbols within each one: real KiCad
	 * shows whichever library has the strongest matching hit first during a
	 * search (e.g. "Device" reliably sorts to the top for a generic-part
	 * query like "c" or "r", since its symbols tend to win the exact-match
	 * tier) rather than staying pinned to its plain alphabetical position.
	 *
	 * Tie-break: when two libraries end up with the same exact/score tier
	 * for the search (common — plenty of real projects keep a local copy of
	 * a generic part like "R"/"C" alongside Device's own), plain alphabetical
	 * comparison would arbitrarily favor whichever nickname happens to sort
	 * earlier, which is why "Device" doesn't reliably land first the way it
	 * does in desktop KiCad (there, it's simply always the first entry in
	 * every install's sym-lib-table, so a stable/rank-preserving tie-break
	 * keeps it on top). DEVICE_LIBRARY_NICKNAME is special-cased in the
	 * tie-break only — not in scoring — to reproduce that same outcome here,
	 * where there is no real per-project sym-lib-table order to preserve.
	 */
	protected override compareLibraryGroups(a: ScoredGroupCompareInput, b: ScoredGroupCompareInput, searching: boolean): number {
		if (searching && a.bestExact === b.bestExact && a.bestScore === b.bestScore) {
			if (a.label === SymbolChooser.DEVICE_LIBRARY_NICKNAME) return -1;
			if (b.label === SymbolChooser.DEVICE_LIBRARY_NICKNAME) return 1;
		}
		return super.compareLibraryGroups(a, b, searching);
	}

	protected async loadPreviewContent(item: PendingSymbol, requestId: number): Promise<boolean | 'stale'> {
		const source = await this.cache.readCachedFile(item.file.id);
		if (requestId !== this.previewRequestId) {
			return 'stale';
		}
		const session = this.ensurePreviewSession();
		const blank = '(kicad_sch (version 20221206) (generator eeschema) (uuid 00000000-0000-0000-0000-000000000000) (paper "A4") (lib_symbols))';
		await session.loadSchematicText(blank, { filename: 'preview.kicad_sch', showDrawingSheet: false });
		if (requestId !== this.previewRequestId) {
			return 'stale';
		}
		const placedRef = session.addLibrarySymbolFromText(source, item.summary.name, 0, 0, item.libId);
		if (!placedRef) {
			return false;
		}
		fitPreviewCameraToContents(session);
		return true;
	}

	// --- Symbol-chooser-specific ------------------------------------------

	protected alreadyPlacedRows(): PendingSymbol[] {
		const session = this.callbacks.getSession();
		if (!session) {
			return [];
		}
		const seen = new Set<string>();
		const out: PendingSymbol[] = [];
		for (const pose of session.listSymbolPoses()) {
			if (!pose.libId || seen.has(pose.libId)) {
				continue;
			}
			seen.add(pose.libId);
			const match = this.rows.find(row => row.libId === pose.libId);
			if (match) {
				out.push(match);
			}
		}
		return out;
	}

	protected libraryId(file: CachedSymbolFile, symbol: CachedSymbolSummary): string {
		if (symbol.name.includes(':')) {
			return symbol.name;
		}
		const library = file.name.replace(/\.kicad_sym$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'Library';
		return `${ library }:${ symbol.name }`;
	}

	protected libraryNickname(item: PendingSymbol): string {
		const idx = item.libId.indexOf(':');
		return idx >= 0 ? item.libId.slice(0, idx) : item.file.relativePath;
	}

	protected confirm(): void {
		if (!this.pendingItem) {
			return;
		}
		const item = this.pendingItem;
		this.close();
		this.pendingItem = item;
		if (this.pendingAnchor) {
			const anchor = this.pendingAnchor;
			this.pendingAnchor = null;
			void this.beginPlacement(anchor);
		}
		else {
			this.callbacks.setEditTool('place-symbol');
			this.callbacks.setStatus(`Click to place ${ item.summary.name }.`);
		}
	}

	protected placeUnit(
		item: PendingSymbol, source: string, x: number, y: number, unit: number,
		reference: string | null
	): string | null {
		return this.callbacks.getSession()
				?.addLibrarySymbolFromText(source, item.summary.name, x, y, item.libId, unit, reference ?? undefined)
			?? null;
	}

	protected async beginPlacement(anchor: Vec2): Promise<void> {
		const item = this.pendingItem, session = this.callbacks.getSession();
		if (!item || !session) {
			return;
		}
		try {
			this.callbacks.setStatus(`Loading ${ item.summary.name }…`);
			const source = await this.cache.readCachedFile(item.file.id);
			const continuing = this.pendingUnitState?.libId === item.libId ? this.pendingUnitState : null;
			if (continuing) {
				const reference = this.placeUnit(
					item, source, anchor.x, anchor.y, continuing.nextUnit, continuing.reference);
				if (!reference) {
					throw new Error(`Could not place ${ item.summary.name }.`);
				}
				this.callbacks.refreshSchematicText(session);
				this.callbacks.setSelectedReference(reference);
				this.finishOrAdvance(item, reference, continuing.nextUnit, continuing.totalUnits);
				return;
			}
			const totalUnits = session.getLibrarySymbolUnitCount(source, item.summary.name);
			this.recordRecentlyUsed(item);
			if (totalUnits > 1 && this.allUnitsEl.checked) {
				let reference: string | null = null;
				for (let unit = 1; unit <= totalUnits; unit++) {
					reference = this.placeUnit(
						item, source, anchor.x, anchor.y + SymbolChooser.BULK_UNIT_SPACING_MM * (unit - 1), unit,
						reference
					);
					if (!reference) {
						throw new Error(`Could not place ${ item.summary.name }.`);
					}
				}
				this.callbacks.refreshSchematicText(session);
				this.callbacks.setSelectedReference(reference);
				this.callbacks.setStatus(
					`Placed ${ item.summary.name } (${ totalUnits } units) as ${ reference }. Click to place another or Esc to stop.`);
				if (!this.repeatCopiesEl.checked) {
					this.pendingItem = null;
					this.callbacks.setEditTool('select');
				}
				return;
			}
			const reference = this.placeUnit(item, source, anchor.x, anchor.y, 1, null);
			if (!reference) {
				throw new Error(`Could not place ${ item.summary.name }.`);
			}
			this.callbacks.refreshSchematicText(session);
			this.callbacks.setSelectedReference(reference);
			this.finishOrAdvance(item, reference, 1, totalUnits);
		}
		catch (error) {
			this.callbacks.setStatus(error instanceof Error ? error.message : String(error));
			this.callbacks.setEditTool('select');
			this.pendingUnitState = null;
		}
	}

	protected finishOrAdvance(item: PendingSymbol, reference: string, placedUnit: number, totalUnits: number): void {
		if (totalUnits > 1 && placedUnit < totalUnits) {
			this.pendingUnitState = { libId: item.libId, reference, nextUnit: placedUnit + 1, totalUnits };
			this.callbacks.setStatus(
				`Placed ${ item.summary.name } unit ${ placedUnit }/${ totalUnits } as ${ reference }. Click to place unit ${ placedUnit
				+ 1 } or Esc to stop.`);
			return;
		}
		this.pendingUnitState = null;
		this.callbacks.setStatus(`Placed ${ item.summary.name }${ totalUnits > 1 ? ` (${ totalUnits } units)` :
			'' } as ${ reference }. Click to place another or Esc to stop.`);
		if (!this.repeatCopiesEl.checked) {
			this.pendingItem = null;
			this.callbacks.setEditTool('select');
		}
	}
}
