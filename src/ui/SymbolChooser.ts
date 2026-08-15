import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { Vec2 }               from '@kicad-render/math/Vec2';
import { BBox }               from '@kicad-render/math/BBox';
import {
	SymbolLibraryCache,
	type CachedSymbolFile,
	type CachedSymbolSummary
}                             from '../io/SymbolLibraryCache';
import { makeDraggableResizable } from './DraggableResizable';

type PendingSymbol = { file: CachedSymbolFile; summary: CachedSymbolSummary; libId: string };
type PendingUnitState = { libId: string; reference: string; nextUnit: number; totalUnits: number };
type ChooserListItem =
	| { type: 'group'; label: string; height: number }
	| { type: 'row'; item: PendingSymbol; height: number };
type ScoredSymbol = { item: PendingSymbol; score: number; exact: boolean };
type SymbolGroup = { label: string; rows: PendingSymbol[] };

export interface SymbolChooserCallbacks {
	getSession(): KicadRenderSession | null;

	refreshSchematicText(session: KicadRenderSession): void;

	setSelectedReference(reference: string | null): void;

	setStatus(message: string): void;

	setEditTool(tool: 'select' | 'place-symbol'): void;
}

/** KiCad-style symbol picker, including preview rendering and virtualized
 *  list handling. It owns all placement state so the canvas editor only
 *  needs to forward a snapped placement point. */
export class SymbolChooser {
	protected readonly el = document.getElementById('symbol-chooser-modal') as HTMLDivElement;
	protected readonly titleEl = document.getElementById('symbol-chooser-title') as HTMLHeadingElement;
	protected readonly filterEl = document.getElementById('symbol-chooser-filter') as HTMLInputElement;
	protected readonly listEl = document.getElementById('symbol-chooser-list') as HTMLDivElement;
	protected readonly detailsEl = document.getElementById('symbol-preview-details') as HTMLDivElement;
	protected readonly previewArtEl = document.getElementById('symbol-preview-art') as HTMLDivElement;
	protected readonly previewCanvasEl = document.getElementById('symbol-preview-canvas') as HTMLCanvasElement;
	protected readonly previewPlaceholderEl = document.getElementById('symbol-preview-placeholder') as HTMLSpanElement;
	protected readonly okEl = document.getElementById('symbol-chooser-ok') as HTMLButtonElement;
	protected readonly cancelEl = document.getElementById('symbol-chooser-cancel') as HTMLButtonElement;
	protected readonly closeEl = document.getElementById('symbol-chooser-close') as HTMLButtonElement;
	protected readonly repeatCopiesEl = document.getElementById('symbol-repeat-copies') as HTMLInputElement;
	protected readonly allUnitsEl = document.getElementById('symbol-all-units') as HTMLInputElement;

	protected previewSession: KicadRenderSession | null = null;
	protected previewRequestId = 0;
	protected pendingSymbol: PendingSymbol | null = null;
	protected rows: PendingSymbol[] = [];
	protected pendingAnchor: Vec2 | null = null;
	protected pendingUnitState: PendingUnitState | null = null;
	protected flatItems: ChooserListItem[] = [];
	protected itemOffsets: number[] = [];
	protected listInnerEl: HTMLDivElement | null = null;
	protected windowFramePending = false;
	/** Real KiCad's "-- Recently Used --" pseudo-group (picksymbol.cpp's
	 *  move-to-front MRU list) — in-memory, most-recent first. Unlike real
	 *  KiCad (which loses this on app restart) this app also persists it to
	 *  localStorage, since a browser tab gets closed/reloaded far more often
	 *  than a desktop KiCad session does. */
	protected recentlyUsed: PendingSymbol[] = [];

	protected static readonly ROW_HEIGHT = 30;
	protected static readonly GROUP_HEIGHT = 24;
	protected static readonly BUFFER_ITEMS = 8;
	protected static readonly BULK_UNIT_SPACING_MM = 12.7;
	/** Matches SYMBOL_CHOOSER_FRAME::s_SymbolHistoryMaxCount in real KiCad. */
	protected static readonly RECENTLY_USED_MAX = 8;
	protected static readonly RECENT_STORAGE_KEY = 'kionline-recent-symbol-libids';
	/** Nickname of the app's bundled fallback library — see
	 *  SymbolLibraryCache.ensureDefaultLibrary's doc comment. Used only to
	 *  break library-group sort ties in buildGroups(), matching desktop
	 *  KiCad's real-world "Device sorts first" behavior. */
	protected static readonly DEVICE_LIBRARY_NICKNAME = 'Device';
	/** True once the user has explicitly clicked a row this time the dialog
	 *  is open — before that, renderList() keeps jumping the selection to
	 *  the top-ranked search match on every keystroke (like real KiCad's
	 *  tree, whose first visible leaf is implicitly "selected"), rather than
	 *  clinging to whatever was merely the default before anything was typed. */
	protected userSelected = false;

	constructor(protected readonly cache: SymbolLibraryCache, protected readonly callbacks: SymbolChooserCallbacks) {
		for (const eventName of [
			'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick'
		]) {
			this.el.addEventListener(eventName, event => event.stopPropagation());
		}
		this.filterEl.addEventListener('input', () => { this.userSelected = false; this.renderList(); });
		this.listEl.addEventListener('scroll', () => this.scheduleWindowRender());
		this.listEl.addEventListener('click', event => this.selectRow(event));
		this.cancelEl.addEventListener('click', () => this.cancelPlacement());
		this.closeEl.addEventListener('click', () => this.cancelPlacement());
		this.okEl.addEventListener('click', () => this.confirm());
		makeDraggableResizable(this.el, this.el.querySelector('.symbol-chooser-header')!, { minWidth: 480, minHeight: 360 });
	}

	get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

	get hasPendingSymbol(): boolean { return this.pendingSymbol !== null; }

	async open(): Promise<void> {
		try {
			const files = await this.cache.getFiles();
			this.rows = files.flatMap(
				file => file.symbols.map(summary => ({ file, summary, libId: this.libraryId(file, summary) })));
			if (!this.recentlyUsed.length) {
				this.recentlyUsed = this.loadRecentLibIds()
					.map(libId => this.rows.find(row => row.libId === libId))
					.filter((row): row is PendingSymbol => !!row)
					.slice(0, SymbolChooser.RECENTLY_USED_MAX);
			}
			this.pendingSymbol = null;
			this.userSelected = false;
			this.titleEl.textContent = `Choose Symbol (${ this.rows.length } items loaded)`;
			this.filterEl.value = '';
			this.el.classList.remove('hidden');
			this.renderList();
			this.filterEl.focus();
		}
		catch (error) {
			this.callbacks.setStatus(error instanceof Error ? error.message : String(error));
		}
	}

	protected loadRecentLibIds(): string[] {
		try {
			const raw = JSON.parse(localStorage.getItem(SymbolChooser.RECENT_STORAGE_KEY) ?? '[]');
			return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
		}
		catch {
			return [];
		}
	}

	protected recordRecentlyUsed(item: PendingSymbol): void {
		this.recentlyUsed = [item, ...this.recentlyUsed.filter(entry => entry.libId !== item.libId)]
			.slice(0, SymbolChooser.RECENTLY_USED_MAX);
		try {
			localStorage.setItem(SymbolChooser.RECENT_STORAGE_KEY, JSON.stringify(this.recentlyUsed.map(entry => entry.libId)));
		}
		catch {
			// Best-effort — losing the persisted MRU list (private browsing,
			// storage quota) just means it behaves like real KiCad's in-memory-only one.
		}
	}

	/** Real KiCad's "-- Already Placed --" pseudo-group (sch_drawing_tools.cpp):
	 *  every distinct lib_id already placed on the CURRENT sheet (this app has
	 *  no cheap way to walk the whole hierarchy from here — see
	 *  KicadRenderSession.listSymbolPoses's own doc comment), resolved back to
	 *  a PendingSymbol only when that library is actually indexed. */
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

	close(): void {
		this.el.classList.add('hidden');
		this.pendingSymbol = null;
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
		if (this.pendingSymbol) {
			void this.beginPlacement(anchor);
			return;
		}
		this.pendingAnchor = anchor;
		void this.open();
	}

	protected libraryId(file: CachedSymbolFile, symbol: CachedSymbolSummary): string {
		if (symbol.name.includes(':')) {
			return symbol.name;
		}
		const library = file.name.replace(/\.kicad_sym$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'Library';
		return `${ library }:${ symbol.name }`;
	}

	protected async renderPreview(item: PendingSymbol | null): Promise<void> {
		const requestId = ++this.previewRequestId;
		if (!item) {
			this.previewCanvasEl.classList.add('hidden');
			this.previewPlaceholderEl.textContent = 'Select a symbol to preview';
			this.previewPlaceholderEl.classList.remove('hidden');
			this.detailsEl.textContent = '';
			this.okEl.disabled = true;
			return;
		}
		const { summary } = item;
		this.detailsEl.innerHTML = `<div class="detail-title">${ summary.name }</div><div class="detail-muted">${ summary.description
		|| 'No description available.' }</div><br>Reference: ${ summary.reference
		|| 'U' }\nUnits: ${ summary.units }\nKeywords: ${ summary.keywords
		|| '—' }\nLibrary: ${ item.file.relativePath }`;
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
			const blank = '(kicad_sch (version 20221206) (generator eeschema) (uuid 00000000-0000-0000-0000-000000000000) (paper "A4") (lib_symbols))';
			await this.previewSession.loadSchematicText(
				blank, { filename: 'preview.kicad_sch', showDrawingSheet: false });
			if (requestId !== this.previewRequestId) {
				return;
			}
			const placedRef = this.previewSession.addLibrarySymbolFromText(source, item.summary.name, 0, 0, item.libId);
			if (!placedRef) {
				throw new Error('Could not render preview.');
			}
			const previewItems = (this.previewSession as any).schScene?.hitTestItems ?? [];
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const hitItem of previewItems) {
				const b = (hitItem as { bbox?: { x: number; y: number; w: number; h: number } }).bbox;
				if (!b) {
					continue;
				}
				minX = Math.min(minX, b.x);
				minY = Math.min(minY, b.y);
				maxX = Math.max(maxX, b.x + b.w);
				maxY = Math.max(maxY, b.y + b.h);
			}
			if (Number.isFinite(minX) && Number.isFinite(maxX)) {
				const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY);
				const padX = width * 0.15, padY = height * 0.15;
				this.previewSession.camera.bbox = new BBox(
					minX - padX, minY - padY, width + padX * 2, height + padY * 2);
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

	protected libraryNickname(item: PendingSymbol): string {
		const idx = item.libId.indexOf(':');
		return idx >= 0 ? item.libId.slice(0, idx) : item.file.relativePath;
	}

	protected naturalCompare(a: string, b: string): number {
		return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
	}

	/**
	 * Ports eeschema's LIB_TREE_NODE::UpdateScore / EDA_COMBINED_MATCHER::
	 * ScoreTerms (common/lib_tree_model.cpp, common/eda_pattern_match.cpp):
	 * AND across whitespace-separated search terms (every term must match
	 * SOMETHING or the item is excluded — returns null), OR across fields
	 * per term (only the best-scoring field counts). Per field: an exact
	 * whole-field match scores 8× that field's weight, a prefix match 2×,
	 * any other substring match 1×. Only a match on an "isName" field
	 * (the symbol's own lib_id or bare name — never keywords/description)
	 * can set `exact`, which real KiCad's sort ranks above raw score.
	 * Field weights mirror LIB_SYMBOL::cacheSearchTerms (lib_symbol.cpp):
	 * lib_id 16, name 8, library nickname 4, keywords 4, Value 4, description 1.
	 */
	protected scoreSearchQuery(query: string, item: PendingSymbol): { score: number; exact: boolean } | null {
		const cleanedQuery = this.normalizeText(query);
		if (!cleanedQuery) {
			return { score: 0, exact: false };
		}
		const terms = cleanedQuery.split(/\s+/).filter(Boolean);
		const candidates = [
			{ text: item.libId, weight: 16, isName: true },
			{ text: item.summary.name, weight: 8, isName: true },
			{ text: this.libraryNickname(item), weight: 4, isName: false },
			{ text: item.summary.keywords, weight: 4, isName: false },
			{ text: item.summary.value, weight: 4, isName: false },
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

	/** Scores+filters a row set against the current search box, then sorts:
	 *  while searching, exact-match items first, then by score, falling back
	 *  to alphabetical (matches LIB_TREE_NODE::Compare's tier order); with no
	 *  search text, plain alphabetical by symbol name. */
	protected scoreAndSort(query: string, rows: PendingSymbol[]): PendingSymbol[] {
		const searching = this.normalizeText(query).length > 0;
		const scored: ScoredSymbol[] = [];
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

	protected buildFlatItems(groups: SymbolGroup[]): void {
		const items: ChooserListItem[] = [];
		for (const group of groups) {
			items.push({ type: 'group', label: group.label, height: SymbolChooser.GROUP_HEIGHT });
			for (const row of group.rows) {
				items.push({ type: 'row', item: row, height: SymbolChooser.ROW_HEIGHT });
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
			empty.textContent = this.rows.length ? 'No matching symbols' : 'Index a .kicad_sym directory first.';
			inner.appendChild(empty);
			return;
		}
		const viewportHeight = this.listEl.clientHeight || 300;
		const start = Math.max(0, this.indexAtOffset(this.listEl.scrollTop) - SymbolChooser.BUFFER_ITEMS);
		const end = Math.min(
			this.flatItems.length - 1,
			this.indexAtOffset(this.listEl.scrollTop + viewportHeight) + SymbolChooser.BUFFER_ITEMS
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
				row.dataset.symbolName = entry.item.summary.name;
				if (this.pendingSymbol && entry.item.file.id === this.pendingSymbol.file.id && entry.item.summary.name
					=== this.pendingSymbol.summary.name) {
					row.classList.add('selected');
				}
				const name = document.createElement('span'), description = document.createElement('small');
				name.textContent = entry.item.summary.name;
				description.textContent = entry.item.summary.description || entry.item.summary.value
					|| entry.item.summary.reference || '';
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

	/** Real KiCad's group order (panel_symbol_chooser.cpp): "-- Recently Used
	 *  --" first, then "-- Already Placed --", then ordinary libraries —
	 *  each alphabetical by nickname (symbol_tree_model_adapter.cpp's
	 *  AssignIntrinsicRanks uses natural string compare). Every group
	 *  (pseudo or real) is scored/filtered by the same search query and
	 *  dropped entirely when it ends up empty. */
	/**
	 * Library group ORDER, not just the symbols within each one: real KiCad
	 * shows whichever library has the strongest matching hit first during a
	 * search (e.g. "Device" reliably sorts to the top for a generic-part
	 * query like "c" or "r", since its symbols tend to win the exact-match
	 * tier) rather than staying pinned to its plain alphabetical position.
	 * With no search text, groups fall back to alphabetical — the same
	 * baseline order symbol_tree_model_adapter.cpp's AssignIntrinsicRanks
	 * establishes before any scoring happens.
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
	protected buildGroups(query: string): SymbolGroup[] {
		const searching = this.normalizeText(query).length > 0;
		const groups: SymbolGroup[] = [];
		const recentRows = this.scoreAndSort(query, this.recentlyUsed);
		if (recentRows.length) {
			groups.push({ label: '-- Recently Used --', rows: recentRows });
		}
		const placedRows = this.scoreAndSort(query, this.alreadyPlacedRows());
		if (placedRows.length) {
			groups.push({ label: '-- Already Placed --', rows: placedRows });
		}
		const byLibrary = new Map<string, PendingSymbol[]>();
		for (const row of this.rows) {
			const key = this.libraryNickname(row);
			(byLibrary.get(key) ?? byLibrary.set(key, []).get(key)!).push(row);
		}
		const libraryGroups: { label: string; rows: PendingSymbol[]; bestScore: number; bestExact: boolean }[] = [];
		for (const name of byLibrary.keys()) {
			const rows = this.scoreAndSort(query, byLibrary.get(name)!);
			if (!rows.length) {
				continue;
			}
			// rows[0] is already this library's best match (scoreAndSort put it
			// first) — re-score just that one row instead of tracking scores
			// through the whole sort.
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
				// Tied on both tiers — see this method's doc comment: break in
				// favor of the built-in Device library rather than falling
				// straight to alphabetical, matching what real KiCad users see.
				if (a.label === SymbolChooser.DEVICE_LIBRARY_NICKNAME) return -1;
				if (b.label === SymbolChooser.DEVICE_LIBRARY_NICKNAME) return 1;
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
			const currentMatches = this.pendingSymbol && filtered.some(item => item.file.id === this.pendingSymbol!.file.id && item.summary.name === this.pendingSymbol!.summary.name);
			if (!this.userSelected || !currentMatches) {
				this.pendingSymbol = filtered[0] ?? null;
				void this.renderPreview(this.pendingSymbol);
			}
		}
		else {
			this.pendingSymbol = null;
			void this.renderPreview(null);
		}
		this.listInnerEl.style.height = `${ this.totalHeight() }px`;
		this.listEl.scrollTop = 0;
		this.renderWindow();
	}

	protected selectRow(event: Event): void {
		const row = (event.target as HTMLElement).closest<HTMLElement>('.symbol-chooser-row');
		if (!row?.dataset.fileId || !row.dataset.symbolName) {
			return;
		}
		this.pendingSymbol = this.rows.find(
			item => item.file.id === row.dataset.fileId && item.summary.name === row.dataset.symbolName) ?? null;
		this.userSelected = true;
		this.renderWindow();
		void this.renderPreview(this.pendingSymbol);
	}

	protected confirm(): void {
		if (!this.pendingSymbol) {
			return;
		}
		const item = this.pendingSymbol;
		this.close();
		this.pendingSymbol = item;
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
		const item = this.pendingSymbol, session = this.callbacks.getSession();
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
					this.pendingSymbol = null;
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
			this.pendingSymbol = null;
			this.callbacks.setEditTool('select');
		}
	}
}
