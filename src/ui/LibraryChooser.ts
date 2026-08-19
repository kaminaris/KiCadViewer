import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { buildFilterSearch } from './Dom';
import { makeDraggableResizable } from './DraggableResizable';
import { LibraryTreeList, type ChooserGroup } from './LibraryTreeList';
import {
	normalizeText, scoreSearchQuery, scoreAndSort, buildScoredGroups, defaultCompareScoredGroups,
	type ScoreField, type ScoreResult, type ScoredGroupCompareInput
} from './search/TextScore';

export type { ChooserGroup } from './LibraryTreeList';

export interface LibraryChooserElementIds {
	modal: string;
	title: string;
	/** Placeholder text for the search box this class BUILDS itself (see
	 *  `buildFilterSearch` in `Dom.ts`) and inserts right after the modal's
	 *  `.symbol-chooser-header` — index.html no longer hand-codes a static
	 *  `.symbol-chooser-search` div per modal. */
	filterPlaceholder: string;
	list: string;
	details: string;
	previewArt: string;
	previewCanvas: string;
	previewPlaceholder: string;
	ok: string;
	cancel: string;
	close: string;
}

/** Shared modal shell for a KiCad-style library-item picker: grouped/scored
 *  search, virtualized row list, a "-- Recently Used --" MRU group, and a
 *  live preview render session — everything `SymbolChooser` and
 *  `FootprintChooser` had duplicated near-verbatim. A subclass supplies the
 *  handful of things that actually differ between symbols and footprints
 *  (how to fetch rows, how an item scores/displays/groups, and how its
 *  preview gets drawn) and keeps its own real differences — SymbolChooser's
 *  multi-unit placement flow, FootprintChooser's promise-returning picker
 *  and fp-filter checkboxes — on top.
 *
 *  Identity: every item is expected to carry its own stable, already-unique
 *  id string (`libId`/`fpId`) — `itemKey()` returns it. That id is what
 *  drives MRU storage, list-row `data-item-key` matching, and "is this the
 *  selected row" checks, replacing the original two classes' slightly
 *  heavier `file.id` + `summary.name` pair comparisons (those pairs were
 *  never meaningfully more precise than the id both classes already treat
 *  as the item's real identity everywhere else — placement, footprint
 *  references, recently-used persistence). */
export abstract class LibraryChooser<TItem> {
	protected readonly el: HTMLDivElement;
	protected readonly titleEl: HTMLHeadingElement;
	protected readonly filterEl: HTMLInputElement;
	protected readonly listEl: HTMLDivElement;
	protected readonly detailsEl: HTMLDivElement;
	protected readonly previewArtEl: HTMLDivElement;
	protected readonly previewCanvasEl: HTMLCanvasElement;
	protected readonly previewPlaceholderEl: HTMLSpanElement;
	protected readonly okEl: HTMLButtonElement;
	protected readonly cancelEl: HTMLButtonElement;
	protected readonly closeEl: HTMLButtonElement;

	protected previewSession: KicadRenderSession | null = null;
	protected previewRequestId = 0;
	protected rows: TItem[] = [];
	protected pendingItem: TItem | null = null;
	/** Owns virtualized rendering + expand/collapse state for the row list —
	 *  see LibraryTreeList's own doc comment for why this is a separate,
	 *  shared class rather than logic kept here (it's the SAME instance
	 *  shape SymbolEditorScreen's always-visible Libraries pane uses). */
	protected readonly tree: LibraryTreeList<TItem>;
	/** Real KiCad's "-- Recently Used --" pseudo-group (picksymbol.cpp's
	 *  move-to-front MRU list) — in-memory, most-recent first. Unlike real
	 *  KiCad (which loses this on app restart) this app also persists it to
	 *  localStorage, since a browser tab gets closed/reloaded far more often
	 *  than a desktop KiCad session does. */
	protected recentlyUsed: TItem[] = [];
	/** True once the user has explicitly clicked a row this time the dialog
	 *  is open — before that, renderList() keeps jumping the selection to
	 *  the top-ranked search match on every keystroke (like real KiCad's
	 *  tree, whose first visible leaf is implicitly "selected"), rather than
	 *  clinging to whatever was merely the default before anything was typed. */
	protected userSelected = false;

	/** Matches SYMBOL_CHOOSER_FRAME::s_SymbolHistoryMaxCount in real KiCad. */
	protected static readonly RECENTLY_USED_MAX = 8;

	protected constructor(ids: LibraryChooserElementIds) {
		this.el = document.getElementById(ids.modal) as HTMLDivElement;
		this.titleEl = document.getElementById(ids.title) as HTMLHeadingElement;
		this.listEl = document.getElementById(ids.list) as HTMLDivElement;
		this.detailsEl = document.getElementById(ids.details) as HTMLDivElement;
		this.previewArtEl = document.getElementById(ids.previewArt) as HTMLDivElement;
		this.previewCanvasEl = document.getElementById(ids.previewCanvas) as HTMLCanvasElement;
		this.previewPlaceholderEl = document.getElementById(ids.previewPlaceholder) as HTMLSpanElement;
		this.okEl = document.getElementById(ids.ok) as HTMLButtonElement;
		this.cancelEl = document.getElementById(ids.cancel) as HTMLButtonElement;
		this.closeEl = document.getElementById(ids.close) as HTMLButtonElement;

		const headerEl = this.el.querySelector<HTMLElement>('.symbol-chooser-header')!;
		const search = buildFilterSearch(ids.filterPlaceholder);
		headerEl.insertAdjacentElement('afterend', search.root);
		this.filterEl = search.input;

		for (const eventName of [
			'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick'
		]) {
			this.el.addEventListener(eventName, event => event.stopPropagation());
		}
		this.filterEl.addEventListener('input', () => { this.userSelected = false; this.renderList(); });
		this.tree = new LibraryTreeList<TItem>(this.listEl, {
			itemKey: item => this.itemKey(item),
			itemName: item => this.itemName(item),
			rowDescription: item => this.rowDescription(item),
			emptyMessage: hasAnyRows => this.emptyMessage(hasAnyRows),
			onSelect: item => this.onTreeSelect(item),
		});
		makeDraggableResizable(this.el, headerEl, { minWidth: 480, minHeight: 360 });
	}

	get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

	// --- Real differences a subclass must supply -----------------------

	protected abstract fetchRows(): Promise<TItem[]>;
	protected abstract itemKey(item: TItem): string;
	protected abstract itemName(item: TItem): string;
	protected abstract rowDescription(item: TItem): string;
	protected abstract scoreFields(item: TItem): ScoreField[];
	protected abstract libraryGroupKey(item: TItem): string;
	protected abstract itemNounPlural(): string;
	protected abstract recentStorageKey(): string;
	protected abstract emptyMessage(hasAnyRows: boolean): string;
	protected abstract previewEmptyMessage(): string;
	protected abstract renderDetails(item: TItem): void;
	protected abstract clearDetails(): void;
	protected abstract onLoadError(error: unknown): void;

	/** Loads whatever the preview needs into `this.previewSession` (which
	 *  `ensurePreviewSession()` has already created/resized by the time this
	 *  runs) and leaves it ready for `.render()`. Must re-check
	 *  `requestId !== this.previewRequestId` after each of ITS OWN await
	 *  points and return `'stale'` immediately if so — a slower, older
	 *  preview request finishing after a newer one must not clobber the
	 *  session state a newer request already started building. Return
	 *  `false` for a real failure (turned into the generic "Could not render
	 *  preview." message by the caller) or `true` on success. */
	protected abstract loadPreviewContent(item: TItem, requestId: number): Promise<boolean | 'stale'>;

	// --- Hooks with a sensible shared default ---------------------------

	protected onBeforeShow(): void { /* no-op by default */ }

	protected candidateRows(): TItem[] { return this.rows; }

	protected recentlyUsedCandidates(): TItem[] { return this.recentlyUsed; }

	protected extraGroups(_query: string): ChooserGroup<TItem>[] { return []; }

	protected compareLibraryGroups(a: ScoredGroupCompareInput, b: ScoredGroupCompareInput, searching: boolean): number {
		return defaultCompareScoredGroups(a, b, searching);
	}

	// --- Shared modal lifecycle ------------------------------------------

	protected hideModal(): void {
		this.el.classList.add('hidden');
	}

	protected async loadAndShow(): Promise<void> {
		try {
			this.rows = await this.fetchRows();
			if (!this.recentlyUsed.length) {
				this.recentlyUsed = this.loadRecentKeys()
					.map(key => this.rows.find(row => this.itemKey(row) === key))
					.filter((row): row is TItem => !!row)
					.slice(0, LibraryChooser.RECENTLY_USED_MAX);
			}
			this.pendingItem = null;
			this.userSelected = false;
			this.titleEl.textContent = `Choose ${ this.itemNounPlural() } (${ this.rows.length } items loaded)`;
			this.filterEl.value = '';
			this.onBeforeShow();
			this.el.classList.remove('hidden');
			this.renderList();
			this.filterEl.focus();
		}
		catch (error) {
			this.onLoadError(error);
		}
	}

	protected loadRecentKeys(): string[] {
		try {
			const raw = JSON.parse(localStorage.getItem(this.recentStorageKey()) ?? '[]');
			return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
		}
		catch {
			return [];
		}
	}

	protected recordRecentlyUsed(item: TItem): void {
		const key = this.itemKey(item);
		this.recentlyUsed = [item, ...this.recentlyUsed.filter(entry => this.itemKey(entry) !== key)]
			.slice(0, LibraryChooser.RECENTLY_USED_MAX);
		try {
			localStorage.setItem(this.recentStorageKey(), JSON.stringify(this.recentlyUsed.map(entry => this.itemKey(entry))));
		}
		catch {
			// Best-effort — losing the persisted MRU list (private browsing,
			// storage quota) just means it behaves like real KiCad's in-memory-only one.
		}
	}

	// --- Search scoring (delegates to the shared TextScore module) -------

	protected scoreSearchQuery(query: string, item: TItem): ScoreResult | null {
		return scoreSearchQuery(query, this.scoreFields(item));
	}

	protected scoreAndSort(query: string, rows: TItem[]): TItem[] {
		return scoreAndSort(query, rows, item => this.scoreFields(item), item => this.itemName(item));
	}

	/** Real KiCad's group order (panel_symbol_chooser.cpp / footprint chooser
	 *  equivalent): "-- Recently Used --" first, then any subclass-specific
	 *  pseudo-groups (`extraGroups`), then ordinary libraries, each
	 *  alphabetical by nickname UNLESS actively searching, in which case
	 *  whichever library has the strongest matching hit floats to the top
	 *  (`compareLibraryGroups`) — matching real KiCad users seeing e.g.
	 *  "Device" reliably sort first for a generic query. Every group (pseudo
	 *  or real) is scored/filtered by the same search query and dropped
	 *  entirely when it ends up empty. */
	protected buildGroups(query: string): ChooserGroup<TItem>[] {
		const groups: ChooserGroup<TItem>[] = [];
		const recentRows = this.scoreAndSort(query, this.recentlyUsedCandidates());
		if (recentRows.length) {
			groups.push({ label: '-- Recently Used --', rows: recentRows });
		}
		groups.push(...this.extraGroups(query));
		groups.push(...buildScoredGroups(
			query, this.candidateRows(), row => this.libraryGroupKey(row), row => this.scoreFields(row),
			row => this.itemName(row), (a, b, searching) => this.compareLibraryGroups(a, b, searching)));
		return groups;
	}

	// --- Row list (delegates virtualized rendering to LibraryTreeList) -----

	protected renderList(): void {
		const query = this.filterEl.value;
		const groups = this.buildGroups(query);
		const filtered = groups.flatMap(group => group.rows);
		if (filtered.length) {
			const currentMatches = this.pendingItem
				&& filtered.some(item => this.itemKey(item) === this.itemKey(this.pendingItem!));
			if (!this.userSelected || !currentMatches) {
				this.pendingItem = filtered[0] ?? null;
				void this.renderPreview(this.pendingItem);
			}
		}
		else {
			this.pendingItem = null;
			void this.renderPreview(null);
		}
		this.tree.setGroups(groups, { searching: normalizeText(query).length > 0, hasAnyRows: this.rows.length > 0 });
		this.tree.setSelectedKey(this.pendingItem ? this.itemKey(this.pendingItem) : null);
	}

	protected onTreeSelect(item: TItem): void {
		this.pendingItem = item;
		this.userSelected = true;
		this.tree.setSelectedKey(this.itemKey(item));
		void this.renderPreview(item);
	}

	// --- Preview session ---------------------------------------------------

	protected ensurePreviewSession(): KicadRenderSession {
		if (!this.previewSession) {
			this.previewSession = new KicadRenderSession(this.previewCanvasEl, null);
		}
		const dpr = window.devicePixelRatio || 1;
		const rect = this.previewArtEl.getBoundingClientRect();
		this.previewSession.resize(Math.max(1, Math.floor(rect.width * dpr)), Math.max(1, Math.floor(rect.height * dpr)));
		return this.previewSession;
	}

	protected async renderPreview(item: TItem | null): Promise<void> {
		const requestId = ++this.previewRequestId;
		if (!item) {
			this.previewCanvasEl.classList.add('hidden');
			this.previewPlaceholderEl.textContent = this.previewEmptyMessage();
			this.previewPlaceholderEl.classList.remove('hidden');
			this.clearDetails();
			this.okEl.disabled = true;
			return;
		}
		this.renderDetails(item);
		this.okEl.disabled = false;
		this.previewPlaceholderEl.textContent = 'Loading preview…';
		this.previewPlaceholderEl.classList.remove('hidden');
		this.previewCanvasEl.classList.add('hidden');
		try {
			const outcome = await this.loadPreviewContent(item, requestId);
			if (outcome === 'stale') {
				return;
			}
			if (!outcome) {
				throw new Error('Could not render preview.');
			}
			this.previewSession!.render();
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
}
