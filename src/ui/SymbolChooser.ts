import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { Vec2 }               from '@kicad-render/math/Vec2';
import { BBox }               from '@kicad-render/math/BBox';
import {
	SymbolLibraryCache,
	type CachedSymbolFile,
	type CachedSymbolSummary
}                             from '../io/SymbolLibraryCache';

type PendingSymbol = { file: CachedSymbolFile; summary: CachedSymbolSummary; libId: string };
type PendingUnitState = { libId: string; reference: string; nextUnit: number; totalUnits: number };
type ChooserListItem =
	| { type: 'group'; label: string; height: number }
	| { type: 'row'; item: PendingSymbol; height: number };

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

	protected static readonly ROW_HEIGHT = 30;
	protected static readonly GROUP_HEIGHT = 24;
	protected static readonly BUFFER_ITEMS = 8;
	protected static readonly BULK_UNIT_SPACING_MM = 12.7;

	constructor(protected readonly cache: SymbolLibraryCache, protected readonly callbacks: SymbolChooserCallbacks) {
		for (const eventName of [
			'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick'
		]) {
			this.el.addEventListener(eventName, event => event.stopPropagation());
		}
		this.filterEl.addEventListener('input', () => this.renderList());
		this.listEl.addEventListener('scroll', () => this.scheduleWindowRender());
		this.listEl.addEventListener('click', event => this.selectRow(event));
		this.cancelEl.addEventListener('click', () => this.cancelPlacement());
		this.closeEl.addEventListener('click', () => this.cancelPlacement());
		this.okEl.addEventListener('click', () => this.confirm());
	}

	get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

	get hasPendingSymbol(): boolean { return this.pendingSymbol !== null; }

	async open(): Promise<void> {
		try {
			const files = await this.cache.getFiles();
			this.rows = files.flatMap(
				file => file.symbols.map(summary => ({ file, summary, libId: this.libraryId(file, summary) })));
			this.pendingSymbol = this.rows[0] ?? null;
			this.titleEl.textContent = `Choose Symbol (${ this.rows.length } items loaded)`;
			this.filterEl.value = '';
			this.el.classList.remove('hidden');
			this.renderList();
			void this.renderPreview(this.pendingSymbol);
			this.filterEl.focus();
		}
		catch (error) {
			this.callbacks.setStatus(error instanceof Error ? error.message : String(error));
		}
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

	protected buildFlatItems(filtered: PendingSymbol[]): void {
		const items: ChooserListItem[] = [];
		let previousFile = '';
		for (const row of filtered) {
			if (row.file.id !== previousFile) {
				items.push({ type: 'group', label: row.file.relativePath, height: SymbolChooser.GROUP_HEIGHT });
				previousFile = row.file.id;
			}
			items.push({ type: 'row', item: row, height: SymbolChooser.ROW_HEIGHT });
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

	protected renderList(): void {
		const query = this.filterEl.value.trim().toLowerCase();
		this.buildFlatItems(this.rows.filter(item => {
			const haystack = `${ item.summary.name } ${ item.summary.value } ${ item.summary.description } ${ item.summary.keywords } ${ item.file.relativePath }`.toLowerCase();
			return !query || haystack.includes(query);
		}));
		if (!this.listInnerEl) {
			this.listEl.replaceChildren();
			this.listInnerEl = document.createElement('div');
			this.listInnerEl.style.position = 'relative';
			this.listEl.appendChild(this.listInnerEl);
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
