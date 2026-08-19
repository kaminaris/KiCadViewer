export type ChooserGroup<TItem> = { label: string; rows: TItem[] };

type FlatEntry<TItem> =
	| { type: 'group'; label: string; height: number; expanded: boolean }
	| { type: 'row'; item: TItem; height: number };

export interface LibraryTreeListHooks<TItem> {
	itemKey(item: TItem): string;
	itemName(item: TItem): string;
	rowDescription(item: TItem): string;
	onSelect(item: TItem): void;
	emptyMessage(hasAnyRows: boolean): string;
}

/** Real KiCad-style collapsible library tree (SYMBOL_TREE_PANE / footprint
 *  chooser tree): one row per library group with an expand/collapse caret,
 *  its items indented underneath. Owns virtualized rendering (absolute-
 *  positioned rows over a fixed-height spacer, windowed to the visible
 *  scroll range) so a huge single-library group like the bundled Device
 *  fallback (~600 symbols) stays cheap to render even fully expanded — the
 *  same math `LibraryChooser`'s modal list used before this class was
 *  extracted from it, now shared verbatim rather than re-implemented.
 *
 *  Deliberately a "dumb" rendering widget: it owns only expand/collapse
 *  state and the virtualized DOM, not which items exist or how they're
 *  scored/filtered/grouped (that stays with whoever calls `setGroups()` —
 *  `LibraryChooser` for the modal pickers, `SymbolEditorScreen` for the
 *  always-visible Libraries pane) — the same "widget owns presentation,
 *  caller owns data" split `ToolPalette` already uses in this codebase.
 *  This is what makes it genuinely reusable 1:1 between the two rather than
 *  two lookalike implementations sharing only CSS class names. */
export class LibraryTreeList<TItem> {
	protected static readonly ROW_HEIGHT = 30;
	protected static readonly GROUP_HEIGHT = 30;
	protected static readonly BUFFER_ITEMS = 8;

	protected groups: ChooserGroup<TItem>[] = [];
	protected searching = false;
	protected hasAnyRows = false;
	/** Per-group manual expand/collapse override. Absent means "use the
	 *  default for this label" (see isExpanded) — pseudo-groups like
	 *  "-- Recently Used --" default open, ordinary libraries default
	 *  closed, matching real KiCad's tree on first open. */
	protected readonly expandOverrides = new Map<string, boolean>();
	protected flatItems: FlatEntry<TItem>[] = [];
	protected itemOffsets: number[] = [];
	protected readonly innerEl: HTMLDivElement;
	protected windowFramePending = false;
	protected selectedKey: string | null = null;

	constructor(protected readonly listEl: HTMLElement, protected readonly hooks: LibraryTreeListHooks<TItem>) {
		this.innerEl = document.createElement('div');
		this.innerEl.style.position = 'relative';
		this.listEl.replaceChildren(this.innerEl);
		this.listEl.addEventListener('scroll', () => this.scheduleRender());
		this.listEl.addEventListener('click', event => this.onClick(event));
	}

	/** Replaces the full row set (e.g. a new search query or a fresh load).
	 *  Jumps scroll back to the top, matching this class's predecessor
	 *  (`LibraryChooser.renderList`)'s existing behavior on every keystroke.
	 *  Use `expandGroup`/`toggleGroup` instead for in-place expand changes
	 *  that shouldn't disturb scroll position. */
	setGroups(groups: ChooserGroup<TItem>[], opts: { searching: boolean; hasAnyRows: boolean }): void {
		this.groups = groups;
		this.searching = opts.searching;
		this.hasAnyRows = opts.hasAnyRows;
		this.rebuildFlatItems();
		this.innerEl.style.height = `${ this.totalHeight() }px`;
		this.listEl.scrollTop = 0;
		this.render();
	}

	setSelectedKey(key: string | null): void {
		this.selectedKey = key;
		this.render();
	}

	/** Forces a group open without affecting scroll position — used to
	 *  auto-expand e.g. the currently-loaded library when the caller has no
	 *  search query driving expansion. */
	expandGroup(label: string): void {
		this.expandOverrides.set(label, true);
		this.rebuildFlatItems();
		this.innerEl.style.height = `${ this.totalHeight() }px`;
		this.render();
	}

	protected isExpanded(label: string): boolean {
		if (this.searching) {
			return true;
		}
		return this.expandOverrides.get(label) ?? label.startsWith('--');
	}

	protected toggleGroup(label: string): void {
		this.expandOverrides.set(label, !this.isExpanded(label));
		this.rebuildFlatItems();
		this.innerEl.style.height = `${ this.totalHeight() }px`;
		this.render();
	}

	protected rebuildFlatItems(): void {
		const items: FlatEntry<TItem>[] = [];
		for (const group of this.groups) {
			const expanded = this.isExpanded(group.label);
			items.push({ type: 'group', label: group.label, height: LibraryTreeList.GROUP_HEIGHT, expanded });
			if (expanded) {
				for (const row of group.rows) {
					items.push({ type: 'row', item: row, height: LibraryTreeList.ROW_HEIGHT });
				}
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

	protected render(): void {
		this.innerEl.replaceChildren();
		if (!this.flatItems.length) {
			const empty = document.createElement('div');
			empty.className = 'symbol-chooser-group';
			empty.textContent = this.hooks.emptyMessage(this.hasAnyRows);
			this.innerEl.appendChild(empty);
			return;
		}
		const viewportHeight = this.listEl.clientHeight || 300;
		const start = Math.max(0, this.indexAtOffset(this.listEl.scrollTop) - LibraryTreeList.BUFFER_ITEMS);
		const end = Math.min(
			this.flatItems.length - 1,
			this.indexAtOffset(this.listEl.scrollTop + viewportHeight) + LibraryTreeList.BUFFER_ITEMS
		);
		for (let i = start; i <= end; i++) {
			const entry = this.flatItems[i]!, top = this.itemOffsets[i]!;
			const row = document.createElement('div');
			row.style.cssText = `position:absolute; top:${ top }px; left:0; right:0;${ entry.type === 'row' ?
				' box-sizing:border-box;' : '' }`;
			if (entry.type === 'group') {
				row.className = 'symbol-chooser-group symbol-chooser-group-collapsible';
				row.dataset.groupLabel = entry.label;
				const caret = document.createElement('span');
				caret.className = 'symbol-chooser-caret';
				caret.textContent = entry.expanded ? '▾' : '▸';
				const label = document.createElement('span');
				label.textContent = entry.label;
				row.append(caret, label);
			}
			else {
				row.className = 'symbol-chooser-row';
				row.dataset.itemKey = this.hooks.itemKey(entry.item);
				if (this.selectedKey && this.hooks.itemKey(entry.item) === this.selectedKey) {
					row.classList.add('selected');
				}
				const name = document.createElement('span'), description = document.createElement('small');
				name.textContent = this.hooks.itemName(entry.item);
				description.textContent = this.hooks.rowDescription(entry.item);
				row.append(name, description);
			}
			this.innerEl.appendChild(row);
		}
	}

	protected scheduleRender(): void {
		if (this.windowFramePending) {
			return;
		}
		this.windowFramePending = true;
		requestAnimationFrame(() => {
			this.windowFramePending = false;
			this.render();
		});
	}

	protected onClick(event: Event): void {
		const target = event.target as HTMLElement;
		const groupRow = target.closest<HTMLElement>('.symbol-chooser-group-collapsible');
		if (groupRow?.dataset.groupLabel !== undefined) {
			this.toggleGroup(groupRow.dataset.groupLabel);
			return;
		}
		const itemRow = target.closest<HTMLElement>('.symbol-chooser-row');
		if (!itemRow?.dataset.itemKey) {
			return;
		}
		const key = itemRow.dataset.itemKey;
		for (const group of this.groups) {
			const found = group.rows.find(row => this.hooks.itemKey(row) === key);
			if (found) {
				this.hooks.onSelect(found);
				return;
			}
		}
	}
}
