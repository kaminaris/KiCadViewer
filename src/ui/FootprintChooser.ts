import {
	FootprintLibraryCache,
	type CachedFootprintFile,
	type CachedFootprintSummary
}                             from '../io/FootprintLibraryCache';
import { LibraryChooser } from './LibraryChooser';
import { type ScoreField } from './search/TextScore';

type PendingFootprint = { file: CachedFootprintFile; summary: CachedFootprintSummary; fpId: string };

/** The placing symbol's own filter data — real KiCad's footprint-chooser
 *  checkboxes only ever appear when there's something to filter by
 *  (pcbnew/widgets/panel_footprint_chooser.cpp builds them conditionally,
 *  ~lines 518-627), so both fields are allowed to be empty/zero. */
export interface FootprintChooserContext {
	fpFilters: string[];
	pinCount: number;
}

export interface FootprintChooserCallbacks {
	setStatus(message: string): void;
}

/** KiCad-style footprint picker — sibling of SymbolChooser.ts, sharing its
 *  modal shell/search/grouping/virtualized-list/MRU/preview-session
 *  machinery via `LibraryChooser` (see that file's own doc comments for the
 *  real-KiCad source each ports). Unlike SymbolChooser this never touches
 *  the canvas/schematic itself — it just resolves a Promise with the
 *  chosen "Library:Name" footprint id (or null on cancel) for the caller
 *  (a Footprint field's browse button) to write wherever it likes. */
export class FootprintChooser extends LibraryChooser<PendingFootprint> {
	protected readonly applyFiltersLabelEl = document.getElementById('footprint-apply-filters-label') as HTMLLabelElement;
	protected readonly applyFiltersEl = document.getElementById('footprint-apply-filters') as HTMLInputElement;
	protected readonly applyFiltersCountEl = document.getElementById('footprint-apply-filters-count') as HTMLSpanElement;
	protected readonly filterPinCountLabelEl = document.getElementById('footprint-filter-pin-count-label') as HTMLLabelElement;
	protected readonly filterPinCountEl = document.getElementById('footprint-filter-pin-count') as HTMLInputElement;
	protected readonly filterPinCountCountEl = document.getElementById('footprint-filter-pin-count-count') as HTMLSpanElement;

	protected context: FootprintChooserContext = { fpFilters: [], pinCount: 0 };
	protected resolveOpen: ((value: string | null) => void) | null = null;

	protected static readonly RECENT_STORAGE_KEY = 'kionline-recent-footprint-ids';

	constructor(protected readonly cache: FootprintLibraryCache, protected readonly callbacks: FootprintChooserCallbacks) {
		super({
			modal: 'footprint-chooser-modal',
			title: 'footprint-chooser-title',
			filterPlaceholder: 'Filter footprints…',
			list: 'footprint-chooser-list',
			details: 'footprint-preview-details',
			previewArt: 'footprint-preview-art',
			previewCanvas: 'footprint-preview-canvas',
			previewPlaceholder: 'footprint-preview-placeholder',
			ok: 'footprint-chooser-ok',
			cancel: 'footprint-chooser-cancel',
			close: 'footprint-chooser-close',
		});
		this.applyFiltersEl.addEventListener('change', () => { this.userSelected = false; this.renderList(); });
		this.filterPinCountEl.addEventListener('change', () => { this.userSelected = false; this.renderList(); });
		this.cancelEl.addEventListener('click', () => this.finish(null));
		this.closeEl.addEventListener('click', () => this.finish(null));
		this.okEl.addEventListener('click', () => this.finish(this.pendingItem?.fpId ?? null));
	}

	open(context: FootprintChooserContext): Promise<string | null> {
		this.context = context;
		return new Promise<string | null>(resolve => {
			this.resolveOpen = resolve;
			void this.loadAndShow();
		});
	}

	protected finish(value: string | null): void {
		this.hideModal();
		if (value && this.pendingItem) {
			this.recordRecentlyUsed(this.pendingItem);
		}
		this.pendingItem = null;
		const resolve = this.resolveOpen;
		this.resolveOpen = null;
		resolve?.(value);
	}

	// --- LibraryChooser hooks ------------------------------------------

	protected async fetchRows(): Promise<PendingFootprint[]> {
		const files = await this.cache.getFiles();
		return files.flatMap(
			file => file.footprints.map(summary => ({ file, summary, fpId: `${ summary.library }:${ summary.name }` })));
	}

	protected itemKey(item: PendingFootprint): string { return item.fpId; }

	protected itemName(item: PendingFootprint): string { return item.summary.name; }

	protected rowDescription(item: PendingFootprint): string { return item.summary.description || ''; }

	protected itemNounPlural(): string { return 'Footprint'; }

	protected recentStorageKey(): string { return FootprintChooser.RECENT_STORAGE_KEY; }

	protected emptyMessage(hasAnyRows: boolean): string {
		return hasAnyRows ? 'No matching footprints' : 'Index a .pretty directory first.';
	}

	protected previewEmptyMessage(): string { return 'Select a footprint to preview'; }

	protected onLoadError(error: unknown): void {
		this.callbacks.setStatus(error instanceof Error ? error.message : String(error));
		this.finish(null);
	}

	protected override onBeforeShow(): void {
		const hasFpFilters = this.context.fpFilters.length > 0;
		const hasPinCount = this.context.pinCount > 0;
		this.applyFiltersLabelEl.classList.toggle('hidden', !hasFpFilters);
		this.filterPinCountLabelEl.classList.toggle('hidden', !hasPinCount);
		this.applyFiltersEl.checked = hasFpFilters;
		this.filterPinCountEl.checked = false;
		this.applyFiltersCountEl.textContent = hasFpFilters ? `(${ this.context.fpFilters.join(' ') })` : '';
		this.filterPinCountCountEl.textContent = hasPinCount ? `(${ this.context.pinCount })` : '';
	}

	protected renderDetails(item: PendingFootprint): void {
		const { summary } = item;
		this.detailsEl.innerHTML = `<div class="detail-title">${ item.fpId }</div><div class="detail-muted">${
			summary.description || 'No description available.' }</div><br>Keywords: ${ summary.keywords || '—' }`;
		if (summary.documentationUrl) {
			const docRow = document.createElement('div');
			docRow.append('Documentation: ');
			const link = document.createElement('a');
			link.href = summary.documentationUrl;
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			link.textContent = summary.documentationUrl;
			docRow.appendChild(link);
			this.detailsEl.appendChild(docRow);
		}
	}

	protected clearDetails(): void {
		this.detailsEl.replaceChildren();
	}

	/** Same weighted-field scoring shape as SymbolChooser.scoreFields (real
	 *  KiCad's footprint tree runs through the identical generic LIB_TREE_
	 *  NODE/EDA_COMBINED_MATCHER framework symbols do) — fpId stands in for
	 *  lib_id, there's no per-footprint "Value" field. */
	protected scoreFields(item: PendingFootprint): ScoreField[] {
		return [
			{ text: item.fpId, weight: 16, isName: true },
			{ text: item.summary.name, weight: 8, isName: true },
			{ text: item.summary.library, weight: 4, isName: false },
			{ text: item.summary.keywords, weight: 4, isName: false },
			{ text: item.summary.description, weight: 1, isName: false },
		];
	}

	protected libraryGroupKey(item: PendingFootprint): string { return item.summary.library; }

	protected override candidateRows(): PendingFootprint[] { return this.rows.filter(row => this.matchesFilters(row)); }

	protected override recentlyUsedCandidates(): PendingFootprint[] {
		return this.recentlyUsed.filter(row => this.matchesFilters(row));
	}

	protected async loadPreviewContent(item: PendingFootprint, requestId: number): Promise<boolean | 'stale'> {
		const source = await this.cache.readCachedFile(item.file.id);
		if (requestId !== this.previewRequestId) {
			return 'stale';
		}
		const session = this.ensurePreviewSession();
		return session.loadFootprintPreviewText(source);
	}

	// --- Footprint-chooser-specific ---------------------------------------

	/** Anchored, case-insensitive wildcard match (`*`/`?`) — ports
	 *  EDA_PATTERN_MATCH_WILDCARD_ANCHORED's intent for ki_fp_filters
	 *  patterns like "TO-92*", matched against the footprint's own name. */
	protected matchesWildcard(pattern: string, value: string): boolean {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
		return new RegExp(`^${ escaped }$`, 'i').test(value);
	}

	/** Real KiCad's filterFootprint() (pcbnew/footprint_chooser_frame.cpp):
	 *  a footprint passes only if EVERY currently-checked filter matches. */
	protected matchesFilters(item: PendingFootprint): boolean {
		if (this.filterPinCountEl.checked && this.context.pinCount > 0
			&& item.summary.padCount !== this.context.pinCount) {
			return false;
		}
		if (this.applyFiltersEl.checked && this.context.fpFilters.length > 0
			&& !this.context.fpFilters.some(pattern => this.matchesWildcard(pattern, item.summary.name))) {
			return false;
		}
		return true;
	}
}
