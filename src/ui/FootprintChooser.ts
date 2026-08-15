import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import {
	FootprintLibraryCache,
	type CachedFootprintFile,
	type CachedFootprintSummary
}                             from '../io/FootprintLibraryCache';
import { makeDraggableResizable } from './DraggableResizable';

type PendingFootprint = { file: CachedFootprintFile; summary: CachedFootprintSummary; fpId: string };
type ChooserListItem =
	| { type: 'group'; label: string; height: number }
	| { type: 'row'; item: PendingFootprint; height: number };
type ScoredFootprint = { item: PendingFootprint; score: number; exact: boolean };
type FootprintGroup = { label: string; rows: PendingFootprint[] };

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

/** KiCad-style footprint picker — sibling of SymbolChooser.ts, reusing its
 *  search-scoring/grouping/virtualized-list machinery near-verbatim (see
 *  that file's own doc comments for the real-KiCad source each ports).
 *  Unlike SymbolChooser this never touches the canvas/schematic itself —
 *  it just resolves a Promise with the chosen "Library:Name" footprint id
 *  (or null on cancel) for the caller (a Footprint field's browse button)
 *  to write wherever it likes. */
export class FootprintChooser {
	protected readonly el = document.getElementById('footprint-chooser-modal') as HTMLDivElement;
	protected readonly titleEl = document.getElementById('footprint-chooser-title') as HTMLHeadingElement;
	protected readonly filterEl = document.getElementById('footprint-chooser-filter') as HTMLInputElement;
	protected readonly listEl = document.getElementById('footprint-chooser-list') as HTMLDivElement;
	protected readonly detailsEl = document.getElementById('footprint-preview-details') as HTMLDivElement;
	protected readonly previewArtEl = document.getElementById('footprint-preview-art') as HTMLDivElement;
	protected readonly previewCanvasEl = document.getElementById('footprint-preview-canvas') as HTMLCanvasElement;
	protected readonly previewPlaceholderEl = document.getElementById('footprint-preview-placeholder') as HTMLSpanElement;
	protected readonly okEl = document.getElementById('footprint-chooser-ok') as HTMLButtonElement;
	protected readonly cancelEl = document.getElementById('footprint-chooser-cancel') as HTMLButtonElement;
	protected readonly closeEl = document.getElementById('footprint-chooser-close') as HTMLButtonElement;
	protected readonly applyFiltersLabelEl = document.getElementById('footprint-apply-filters-label') as HTMLLabelElement;
	protected readonly applyFiltersEl = document.getElementById('footprint-apply-filters') as HTMLInputElement;
	protected readonly applyFiltersCountEl = document.getElementById('footprint-apply-filters-count') as HTMLSpanElement;
	protected readonly filterPinCountLabelEl = document.getElementById('footprint-filter-pin-count-label') as HTMLLabelElement;
	protected readonly filterPinCountEl = document.getElementById('footprint-filter-pin-count') as HTMLInputElement;
	protected readonly filterPinCountCountEl = document.getElementById('footprint-filter-pin-count-count') as HTMLSpanElement;

	protected previewSession: KicadRenderSession | null = null;
	protected previewRequestId = 0;
	protected pendingFootprint: PendingFootprint | null = null;
	protected rows: PendingFootprint[] = [];
	protected context: FootprintChooserContext = { fpFilters: [], pinCount: 0 };
	protected resolveOpen: ((value: string | null) => void) | null = null;
	protected flatItems: ChooserListItem[] = [];
	protected itemOffsets: number[] = [];
	protected listInnerEl: HTMLDivElement | null = null;
	protected windowFramePending = false;
	/** Same idea as SymbolChooser's own "-- Recently Used --" MRU list —
	 *  localStorage-persisted, most-recent first, capped the same way. */
	protected recentlyUsed: PendingFootprint[] = [];

	protected static readonly ROW_HEIGHT = 30;
	protected static readonly GROUP_HEIGHT = 24;
	protected static readonly BUFFER_ITEMS = 8;
	protected static readonly RECENTLY_USED_MAX = 8;
	protected static readonly RECENT_STORAGE_KEY = 'kionline-recent-footprint-ids';
	/** Same "don't clobber an explicit click with the top search match"
	 *  guard SymbolChooser uses — see its own doc comment. */
	protected userSelected = false;

	constructor(protected readonly cache: FootprintLibraryCache, protected readonly callbacks: FootprintChooserCallbacks) {
		for (const eventName of [
			'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick'
		]) {
			this.el.addEventListener(eventName, event => event.stopPropagation());
		}
		this.filterEl.addEventListener('input', () => { this.userSelected = false; this.renderList(); });
		this.listEl.addEventListener('scroll', () => this.scheduleWindowRender());
		this.listEl.addEventListener('click', event => this.selectRow(event));
		this.applyFiltersEl.addEventListener('change', () => { this.userSelected = false; this.renderList(); });
		this.filterPinCountEl.addEventListener('change', () => { this.userSelected = false; this.renderList(); });
		this.cancelEl.addEventListener('click', () => this.finish(null));
		this.closeEl.addEventListener('click', () => this.finish(null));
		this.okEl.addEventListener('click', () => this.finish(this.pendingFootprint?.fpId ?? null));
		makeDraggableResizable(this.el, this.el.querySelector('.symbol-chooser-header')!, { minWidth: 480, minHeight: 360 });
	}

	get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

	open(context: FootprintChooserContext): Promise<string | null> {
		return new Promise<string | null>(resolve => {
			this.resolveOpen = resolve;
			void this.load(context);
		});
	}

	protected async load(context: FootprintChooserContext): Promise<void> {
		this.context = context;
		try {
			const files = await this.cache.getFiles();
			this.rows = files.flatMap(
				file => file.footprints.map(summary => ({ file, summary, fpId: `${ summary.library }:${ summary.name }` })));
			if (!this.recentlyUsed.length) {
				this.recentlyUsed = this.loadRecentIds()
					.map(fpId => this.rows.find(row => row.fpId === fpId))
					.filter((row): row is PendingFootprint => !!row)
					.slice(0, FootprintChooser.RECENTLY_USED_MAX);
			}
			this.pendingFootprint = null;
			this.userSelected = false;
			this.titleEl.textContent = `Choose Footprint (${ this.rows.length } items loaded)`;
			this.filterEl.value = '';

			const hasFpFilters = context.fpFilters.length > 0;
			const hasPinCount = context.pinCount > 0;
			this.applyFiltersLabelEl.classList.toggle('hidden', !hasFpFilters);
			this.filterPinCountLabelEl.classList.toggle('hidden', !hasPinCount);
			this.applyFiltersEl.checked = hasFpFilters;
			this.filterPinCountEl.checked = false;
			this.applyFiltersCountEl.textContent = hasFpFilters ? `(${ context.fpFilters.join(' ') })` : '';
			this.filterPinCountCountEl.textContent = hasPinCount ? `(${ context.pinCount })` : '';

			this.el.classList.remove('hidden');
			this.renderList();
			this.filterEl.focus();
		}
		catch (error) {
			this.callbacks.setStatus(error instanceof Error ? error.message : String(error));
			this.finish(null);
		}
	}

	protected finish(value: string | null): void {
		this.el.classList.add('hidden');
		if (value && this.pendingFootprint) {
			this.recordRecentlyUsed(this.pendingFootprint);
		}
		this.pendingFootprint = null;
		const resolve = this.resolveOpen;
		this.resolveOpen = null;
		resolve?.(value);
	}

	protected loadRecentIds(): string[] {
		try {
			const raw = JSON.parse(localStorage.getItem(FootprintChooser.RECENT_STORAGE_KEY) ?? '[]');
			return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
		}
		catch {
			return [];
		}
	}

	protected recordRecentlyUsed(item: PendingFootprint): void {
		this.recentlyUsed = [item, ...this.recentlyUsed.filter(entry => entry.fpId !== item.fpId)]
			.slice(0, FootprintChooser.RECENTLY_USED_MAX);
		try {
			localStorage.setItem(FootprintChooser.RECENT_STORAGE_KEY, JSON.stringify(this.recentlyUsed.map(entry => entry.fpId)));
		}
		catch {
			// Best-effort — see SymbolChooser.recordRecentlyUsed's identical note.
		}
	}

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

	protected async renderPreview(item: PendingFootprint | null): Promise<void> {
		const requestId = ++this.previewRequestId;
		if (!item) {
			this.previewCanvasEl.classList.add('hidden');
			this.previewPlaceholderEl.textContent = 'Select a footprint to preview';
			this.previewPlaceholderEl.classList.remove('hidden');
			this.detailsEl.replaceChildren();
			this.okEl.disabled = true;
			return;
		}
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
		this.okEl.disabled = false;
		this.previewPlaceholderEl.textContent = 'Loading preview…';
		this.previewPlaceholderEl.classList.remove('hidden');
		this.previewCanvasEl.classList.add('hidden');
		try {
			const source = await this.cache.readCachedFile(item.file.id);
			if (requestId !== this.previewRequestId) {
				return;
			}
			if (!this.previewSession) {
				this.previewSession = new KicadRenderSession(this.previewCanvasEl, null);
			}
			const dpr = window.devicePixelRatio || 1;
			const rect = this.previewArtEl.getBoundingClientRect();
			this.previewSession.resize(
				Math.max(1, Math.floor(rect.width * dpr)), Math.max(1, Math.floor(rect.height * dpr)));
			const ok = this.previewSession.loadFootprintPreviewText(source);
			if (requestId !== this.previewRequestId) {
				return;
			}
			if (!ok) {
				throw new Error('Could not render preview.');
			}
			this.previewSession.render();
			this.previewPlaceholderEl.classList.add('hidden');
			this.previewCanvasEl.classList.remove('hidden');
		}
		catch (error) {
			if (requestId !== this.previewRequestId) {
				return;
			}
			this.previewPlaceholderEl.textContent = error instanceof Error ? error.message :
				'Could not render preview.';
			this.previewPlaceholderEl.classList.remove('hidden');
			this.previewCanvasEl.classList.add('hidden');
		}
	}

	protected normalizeText(value: string): string {
		return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	}

	protected naturalCompare(a: string, b: string): number {
		return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
	}

	/** Same weighted-field scoring shape as SymbolChooser.scoreSearchQuery
	 *  (real KiCad's footprint tree runs through the identical generic
	 *  LIB_TREE_NODE/EDA_COMBINED_MATCHER framework symbols do) — fpId
	 *  stands in for lib_id, there's no per-footprint "Value" field. */
	protected scoreSearchQuery(query: string, item: PendingFootprint): { score: number; exact: boolean } | null {
		const cleanedQuery = this.normalizeText(query);
		if (!cleanedQuery) {
			return { score: 0, exact: false };
		}
		const terms = cleanedQuery.split(/\s+/).filter(Boolean);
		const candidates = [
			{ text: item.fpId, weight: 16, isName: true },
			{ text: item.summary.name, weight: 8, isName: true },
			{ text: item.summary.library, weight: 4, isName: false },
			{ text: item.summary.keywords, weight: 4, isName: false },
			{ text: item.summary.description, weight: 1, isName: false }
		];

		let total = 0, anyExact = false;
		for (const term of terms) {
			let bestFieldScore = 0, bestFieldExact = false;
			for (const cand of candidates) {
				const normalized = this.normalizeText(cand.text ?? '');
				if (!normalized) {
					continue;
				}
				let fieldScore = 0, fieldExact = false;
				if (normalized === term) {
					fieldScore = 8 * cand.weight;
					fieldExact = cand.isName;
				}
				else if (normalized.startsWith(term)) {
					fieldScore = 2 * cand.weight;
				}
				else if (normalized.includes(term)) {
					fieldScore = cand.weight;
				}
				if (fieldScore > bestFieldScore) {
					bestFieldScore = fieldScore;
					bestFieldExact = fieldExact;
				}
			}
			if (bestFieldScore <= 0) {
				return null;
			}
			total += bestFieldScore;
			anyExact = anyExact || bestFieldExact;
		}
		return { score: total, exact: anyExact };
	}

	protected scoreAndSort(query: string, rows: PendingFootprint[]): PendingFootprint[] {
		const searching = this.normalizeText(query).length > 0;
		const scored: ScoredFootprint[] = [];
		for (const item of rows) {
			const result = this.scoreSearchQuery(query, item);
			if (result) {
				scored.push({ item, score: result.score, exact: result.exact });
			}
		}
		scored.sort((a, b) => {
			if (searching) {
				if (a.exact !== b.exact) {
					return a.exact ? -1 : 1;
				}
				if (a.score !== b.score) {
					return b.score - a.score;
				}
			}
			return this.naturalCompare(a.item.summary.name, b.item.summary.name);
		});
		return scored.map(entry => entry.item);
	}

	protected buildFlatItems(groups: FootprintGroup[]): void {
		const items: ChooserListItem[] = [];
		for (const group of groups) {
			items.push({ type: 'group', label: group.label, height: FootprintChooser.GROUP_HEIGHT });
			for (const row of group.rows) {
				items.push({ type: 'row', item: row, height: FootprintChooser.ROW_HEIGHT });
			}
		}
		this.flatItems = items;
		let cursor = 0;
		this.itemOffsets = items.map(entry => {
			const offset = cursor;
			cursor += entry.height;
			return offset;
		});
	}

	protected totalHeight(): number {
		const last = this.flatItems.length - 1;
		return last < 0 ? 0 : this.itemOffsets[last]! + this.flatItems[last]!.height;
	}

	protected indexAtOffset(y: number): number {
		let lo = 0, hi = this.flatItems.length - 1, result = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.itemOffsets[mid]! + this.flatItems[mid]!.height > y) {
				result = mid;
				hi = mid - 1;
			}
			else {
				lo = mid + 1;
			}
		}
		return result;
	}

	protected renderWindow(): void {
		const inner = this.listInnerEl;
		if (!inner) {
			return;
		}
		inner.replaceChildren();
		if (!this.flatItems.length) {
			const empty = document.createElement('div');
			empty.className = 'symbol-chooser-group';
			empty.textContent = this.rows.length ? 'No matching footprints' : 'Index a .pretty directory first.';
			inner.appendChild(empty);
			return;
		}
		const viewportHeight = this.listEl.clientHeight || 300;
		const start = Math.max(0, this.indexAtOffset(this.listEl.scrollTop) - FootprintChooser.BUFFER_ITEMS);
		const end = Math.min(
			this.flatItems.length - 1,
			this.indexAtOffset(this.listEl.scrollTop + viewportHeight) + FootprintChooser.BUFFER_ITEMS
		);
		for (let i = start; i <= end; i++) {
			const entry = this.flatItems[i]!, top = this.itemOffsets[i]!;
			const row = document.createElement('div');
			row.className = entry.type === 'group' ? 'symbol-chooser-group' : 'symbol-chooser-row';
			row.style.cssText = `position:absolute; top:${ top }px; left:0; right:0;${ entry.type === 'row' ?
				' box-sizing:border-box;' : '' }`;
			if (entry.type === 'group') {
				row.textContent = entry.label;
			}
			else {
				row.dataset.fileId = entry.item.file.id;
				row.dataset.footprintName = entry.item.summary.name;
				if (this.pendingFootprint && entry.item.file.id === this.pendingFootprint.file.id && entry.item.summary.name
					=== this.pendingFootprint.summary.name) {
					row.classList.add('selected');
				}
				const name = document.createElement('span'), description = document.createElement('small');
				name.textContent = entry.item.summary.name;
				description.textContent = entry.item.summary.description || '';
				row.append(name, description);
			}
			inner.appendChild(row);
		}
	}

	protected scheduleWindowRender(): void {
		if (this.windowFramePending) {
			return;
		}
		this.windowFramePending = true;
		requestAnimationFrame(() => {
			this.windowFramePending = false;
			this.renderWindow();
		});
	}

	/** Group order: "-- Recently Used --" first, then ordinary libraries —
	 *  same best-match-floats-to-top-during-search logic as SymbolChooser.
	 *  buildGroups (see its own doc comment), minus the Device-library
	 *  tie-break (no footprint equivalent — plain alphabetical tie-break
	 *  instead). Every row set is filtered by the current checkbox state
	 *  (matchesFilters) before scoring/grouping. */
	protected buildGroups(query: string): FootprintGroup[] {
		const searching = this.normalizeText(query).length > 0;
		const candidateRows = this.rows.filter(row => this.matchesFilters(row));
		const groups: FootprintGroup[] = [];

		const recentRows = this.scoreAndSort(query, this.recentlyUsed.filter(row => this.matchesFilters(row)));
		if (recentRows.length) {
			groups.push({ label: '-- Recently Used --', rows: recentRows });
		}

		const byLibrary = new Map<string, PendingFootprint[]>();
		for (const row of candidateRows) {
			(byLibrary.get(row.summary.library) ?? byLibrary.set(row.summary.library, []).get(row.summary.library)!)
				.push(row);
		}
		const libraryGroups: { label: string; rows: PendingFootprint[]; bestScore: number; bestExact: boolean }[] = [];
		for (const name of byLibrary.keys()) {
			const rows = this.scoreAndSort(query, byLibrary.get(name)!);
			if (!rows.length) {
				continue;
			}
			const best = searching ? this.scoreSearchQuery(query, rows[0]!) : null;
			libraryGroups.push({ label: name, rows, bestScore: best?.score ?? 0, bestExact: best?.exact ?? false });
		}
		libraryGroups.sort((a, b) => {
			if (searching) {
				if (a.bestExact !== b.bestExact) {
					return a.bestExact ? -1 : 1;
				}
				if (a.bestScore !== b.bestScore) {
					return b.bestScore - a.bestScore;
				}
			}
			return this.naturalCompare(a.label, b.label);
		});
		groups.push(...libraryGroups.map(({ label, rows }) => ({ label, rows })));
		return groups;
	}

	protected renderList(): void {
		const query = this.filterEl.value;
		const groups = this.buildGroups(query);
		const filtered = groups.flatMap(group => group.rows);
		this.buildFlatItems(groups);
		if (!this.listInnerEl) {
			this.listEl.replaceChildren();
			this.listInnerEl = document.createElement('div');
			this.listInnerEl.style.position = 'relative';
			this.listEl.appendChild(this.listInnerEl);
		}
		if (filtered.length) {
			const currentMatches = this.pendingFootprint && filtered.some(
				item => item.file.id === this.pendingFootprint!.file.id
					&& item.summary.name === this.pendingFootprint!.summary.name);
			if (!this.userSelected || !currentMatches) {
				this.pendingFootprint = filtered[0] ?? null;
				void this.renderPreview(this.pendingFootprint);
			}
		}
		else {
			this.pendingFootprint = null;
			void this.renderPreview(null);
		}
		this.listInnerEl.style.height = `${ this.totalHeight() }px`;
		this.listEl.scrollTop = 0;
		this.renderWindow();
	}

	protected selectRow(event: Event): void {
		const row = (event.target as HTMLElement).closest<HTMLElement>('.symbol-chooser-row');
		if (!row?.dataset.fileId || !row.dataset.footprintName) {
			return;
		}
		this.pendingFootprint = this.rows.find(
			item => item.file.id === row.dataset.fileId && item.summary.name === row.dataset.footprintName) ?? null;
		this.userSelected = true;
		this.renderWindow();
		void this.renderPreview(this.pendingFootprint);
	}
}
