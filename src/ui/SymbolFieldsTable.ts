import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { KicadSchematic } from '@kicad-io/Project/KicadSchematic';
import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';
import { KicadElementLibSymbols } from '@kicad-io/KicadElementLibSymbols';
import { KicadParser } from '@kicad-io/KicadParser';
import type { ProjectContext } from '../app/ProjectContext';
import { makeDraggableResizable } from './DraggableResizable';

/** One column in both the left field-list panel and the main grid.
 *  `originalName` is the property name as it exists on disk right now —
 *  null for a field the user just added this session (nothing to rename/
 *  delete against on commit). `name` is the CURRENT working name shown in
 *  the UI, which only diverges from `originalName` while a pending rename
 *  hasn't been committed yet. */
interface FieldConfig {
	name: string;
	show: boolean;
	groupBy: boolean;
	mandatory: boolean;
	originalName: string | null;
}

interface SymbolRow {
	uuid: string;
	sheet: KicadSchematic;
	symbol: KicadElementSymbol;
}

interface GroupRow {
	key: string;
	members: SymbolRow[];
}

export interface SymbolFieldsTableCallbacks {
	setStatus(message: string): void;

	getSession(): KicadRenderSession | null;

	getProjectContext(): ProjectContext | null;

	getCurrentSheetNode(): KicadSchematic | null;

	saveProject(): Promise<void>;

	refreshSidebar(): void;

	openFootprintChooser(context: { fpFilters: string[]; pinCount: number }): Promise<string | null>;
}

/** Reference/Value/Datasheet/Footprint — this app's own existing mandatory-
 *  field set (PropertyDialogRenderers.renderSymbol's `mandatory` Set),
 *  reused here rather than introducing a second definition. Real KiCad also
 *  treats Description as mandatory; this app doesn't special-case it
 *  anywhere else, so it isn't here either. Display order matches the
 *  screenshot (Reference, Value, Datasheet, Footprint). */
const MANDATORY_FIELDS = ['Reference', 'Value', 'Datasheet', 'Footprint'];
/** Value/Footprint grouped by default mirrors this app's own existing
 *  groupBOM() convention (Value|Footprint|MPN key) — Reference's own
 *  groupBy flag is what actually enables prefix-collapsing (see
 *  buildGroupKey); Datasheet/custom fields start ungrouped. */
const DEFAULT_GROUP_BY = new Set(['Reference', 'Value', 'Footprint']);

function csvEscape(value: string): string {
	return /[",\r\n]/.test(value) ? `"${ value.replace(/"/g, '""') }"` : value;
}

function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** KiCad-style bulk symbol-field editor — every symbol across the whole
 *  open project (or just the current sheet in single-file/no-project mode)
 *  in one grid, with grouping and mixed-value display ported from real
 *  KiCad's fields_data_model.cpp. Edits are BUFFERED (a pending-edit map)
 *  until Apply/OK — Cancel is a true no-op, never touching the AST. See
 *  the harmonic-munching-trinket plan for the full design, including the
 *  save-path resync gotcha this class's commit() works around. */
export class SymbolFieldsTable {
	protected readonly el = document.getElementById('symbol-fields-table-modal') as HTMLDivElement;
	protected readonly closeEl = document.getElementById('sft-close') as HTMLButtonElement;
	protected readonly fieldListEl = document.getElementById('sft-field-list') as HTMLDivElement;
	protected readonly addFieldEl = document.getElementById('sft-add-field') as HTMLButtonElement;
	protected readonly tabEditEl = document.getElementById('sft-tab-edit') as HTMLButtonElement;
	protected readonly tabExportEl = document.getElementById('sft-tab-export') as HTMLButtonElement;
	protected readonly panelEditEl = document.getElementById('sft-panel-edit') as HTMLDivElement;
	protected readonly panelExportEl = document.getElementById('sft-panel-export') as HTMLDivElement;
	protected readonly filterEl = document.getElementById('sft-filter') as HTMLInputElement;
	protected readonly scopeEl = document.getElementById('sft-scope') as HTMLSelectElement;
	protected readonly groupSymbolsEl = document.getElementById('sft-group-symbols') as HTMLInputElement;
	protected readonly gridWrapEl = document.getElementById('sft-grid-wrap') as HTMLDivElement;
	protected readonly exportSummaryEl = document.getElementById('sft-export-summary') as HTMLDivElement;
	protected readonly exportBtnEl = document.getElementById('sft-export') as HTMLButtonElement;
	protected readonly applyBtnEl = document.getElementById('sft-apply') as HTMLButtonElement;
	protected readonly okBtnEl = document.getElementById('sft-ok') as HTMLButtonElement;
	protected readonly cancelBtnEl = document.getElementById('sft-cancel') as HTMLButtonElement;

	protected rows: SymbolRow[] = [];
	protected fields: FieldConfig[] = [];
	/** uuid -> fieldName (current name) -> pending value. */
	protected pendingEdits = new Map<string, Map<string, string>>();
	protected pendingFieldDeletes = new Set<string>();
	/** originalName -> newName. */
	protected pendingFieldRenames = new Map<string, string>();
	protected expandedGroupKeys = new Set<string>();
	protected groupSymbols = true;
	protected scope: 'project' | 'sheet' = 'project';
	protected activeTab: 'edit' | 'export' = 'edit';
	protected filterText = '';

	constructor(protected readonly callbacks: SymbolFieldsTableCallbacks) {
		for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick']) {
			this.el.addEventListener(eventName, event => event.stopPropagation());
		}
		this.closeEl.addEventListener('click', () => this.cancel());
		this.cancelBtnEl.addEventListener('click', () => this.cancel());
		this.addFieldEl.addEventListener('click', () => this.addField());
		this.tabEditEl.addEventListener('click', () => this.setActiveTab('edit'));
		this.tabExportEl.addEventListener('click', () => this.setActiveTab('export'));
		this.filterEl.addEventListener('input', () => {
			this.filterText = this.filterEl.value;
			this.renderGrid();
		});
		this.scopeEl.addEventListener('change', () => {
			this.scope = this.scopeEl.value === 'sheet' ? 'sheet' : 'project';
			this.renderGrid();
			this.renderExportSummary();
		});
		this.groupSymbolsEl.addEventListener('change', () => {
			this.groupSymbols = this.groupSymbolsEl.checked;
			this.renderGrid();
			this.renderExportSummary();
		});
		this.exportBtnEl.addEventListener('click', () => this.downloadCsv());
		this.applyBtnEl.addEventListener('click', () => void this.commit(false));
		this.okBtnEl.addEventListener('click', () => void this.commit(true));
		makeDraggableResizable(this.el, this.el.querySelector('.sft-header')!, { minWidth: 640, minHeight: 400 });
	}

	get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

	open(): void {
		this.load();
		this.el.classList.remove('hidden');
	}

	protected cancel(): void {
		this.pendingEdits.clear();
		this.pendingFieldDeletes.clear();
		this.pendingFieldRenames.clear();
		this.el.classList.add('hidden');
	}

	protected close(): void {
		this.el.classList.add('hidden');
	}

	// ---- Data loading -----------------------------------------------------

	protected load(): void {
		this.rows = this.collectRows();
		this.fields = this.buildFieldConfigs(this.rows);
		this.pendingEdits.clear();
		this.pendingFieldDeletes.clear();
		this.pendingFieldRenames.clear();
		this.expandedGroupKeys.clear();
		this.filterText = '';
		this.filterEl.value = '';
		this.setActiveTab('edit');
		this.renderFieldList();
		this.renderGrid();
		this.renderExportSummary();
	}

	protected collectRows(): SymbolRow[] {
		const projectContext = this.callbacks.getProjectContext();
		if (projectContext?.project.mainSchematic) {
			this.syncCurrentSheetFromLiveSession();
			return this.walkSheet(projectContext.project.mainSchematic);
		}
		// No project open — fall back to whatever single schematic is
		// currently loaded into the render session, so the dialog still
		// works (single-sheet-only) rather than being unusable.
		const text = this.callbacks.getSession()?.getSchematicText();
		if (!text) {
			return [];
		}
		const fallbackSheet = new KicadSchematic();
		fallbackSheet.rootElement = new KicadParser().parse(text);
		return this.walkSheet(fallbackSheet);
	}

	/** The render session only ever holds ONE sheet's live text at a time
	 *  (whichever is currently open in the canvas) — edits made there aren't
	 *  written back into that sheet's own KicadSchematic.rootElement until
	 *  an explicit save happens (SessionController.saveProject() does
	 *  exactly this same re-derive-from-getSchematicText() step). Without
	 *  this, the table would silently miss any not-yet-saved edit on the
	 *  currently-open sheet — mirrors the write-back resync in commit(),
	 *  just in the opposite direction (session -> AST instead of AST ->
	 *  session). */
	protected syncCurrentSheetFromLiveSession(): void {
		const currentSheet = this.callbacks.getCurrentSheetNode();
		const liveText = this.callbacks.getSession()?.getSchematicText();
		if (currentSheet && liveText) {
			currentSheet.rootElement = new KicadParser().parse(liveText);
		}
	}

	protected walkSheet(sheet: KicadSchematic): SymbolRow[] {
		const rows: SymbolRow[] = [];
		if (sheet.rootElement) {
			sheet.getAllSymbols(false).forEach((symbol, index) => {
				// Power/graphic pseudo-symbols (#PWR01, …) are excluded from
				// the fields table the same way this app's own getBOM()
				// already excludes them — matches real KiCad's
				// SYMBOL_FILTER_NON_POWER.
				if (symbol.getReference().startsWith('#')) {
					return;
				}
				rows.push({ uuid: symbol.getUuid() ?? `${ sheet.path }:${ index }`, sheet, symbol });
			});
		}
		for (const child of sheet.sheets) {
			rows.push(...this.walkSheet(child));
		}
		return rows;
	}

	protected buildFieldConfigs(rows: SymbolRow[]): FieldConfig[] {
		const configs = new Map<string, FieldConfig>();
		for (const name of MANDATORY_FIELDS) {
			configs.set(
				name, { name, show: true, groupBy: DEFAULT_GROUP_BY.has(name), mandatory: true, originalName: name });
		}
		for (const row of rows) {
			for (const name of Object.keys(row.symbol.getAllProperties())) {
				if (!configs.has(name)) {
					configs.set(name, { name, show: false, groupBy: false, mandatory: false, originalName: name });
				}
			}
		}
		const mandatory = MANDATORY_FIELDS.map(name => configs.get(name)!);
		const custom = [...configs.values()].filter(f => !f.mandatory)
			.sort((a, b) => naturalCompare(a.name, b.name));
		return [...mandatory, ...custom];
	}

	// ---- Field-value access (buffered) -------------------------------------

	protected getValue(row: SymbolRow, field: FieldConfig): string {
		const edits = this.pendingEdits.get(row.uuid);
		if (edits?.has(field.name)) {
			return edits.get(field.name)!;
		}
		const key = field.originalName ?? field.name;
		return row.symbol.getPropertyByName(key)?.propertyValue ?? '';
	}

	protected setValue(row: SymbolRow, field: FieldConfig, value: string): void {
		let edits = this.pendingEdits.get(row.uuid);
		if (!edits) {
			edits = new Map();
			this.pendingEdits.set(row.uuid, edits);
		}
		edits.set(field.name, value);
	}

	// ---- Filtering / scoping / grouping -------------------------------------

	protected visibleColumns(): FieldConfig[] {
		return this.fields.filter(f => f.show);
	}

	protected scopedRows(): SymbolRow[] {
		let rows = this.rows;
		if (this.scope === 'sheet') {
			const current = this.callbacks.getCurrentSheetNode();
			rows = rows.filter(r => r.sheet === current);
		}
		const needle = this.filterText.trim().toLowerCase();
		if (needle) {
			const columns = this.visibleColumns();
			rows = rows.filter(row => columns.some(field => this.getValue(row, field).toLowerCase().includes(needle)));
		}
		return rows;
	}

	/** Resolves a placed symbol's library definition directly from its OWN
	 *  sheet's AST — deliberately NOT KicadRenderSession.findLibSymbolForInstance,
	 *  which only works for whatever ONE sheet is currently rendered (it looks
	 *  up by paint id, assigned only to the live scene). Rows here can belong
	 *  to any sheet in the project, so this ports that method's lookup logic
	 *  (lib_name override, else lib_id, against the sheet's own lib_symbols)
	 *  against the row's own sheet instead. Used to seed the Footprint
	 *  browse button's ki_fp_filters/pin-count context. */
	protected resolveLibSymbolFor(row: SymbolRow): KicadElementSymbol | null {
		const libSymbols = row.sheet.rootElement?.findFirstChildByClass(KicadElementLibSymbols);
		const libLookupName = row.symbol.getLibName() ?? row.symbol.getLibId();
		return (libLookupName && libSymbols ? libSymbols.findSymbolByName(libLookupName) : null) ?? null;
	}

	protected buildGroupKey(row: SymbolRow): string {
		if (!this.groupSymbols) {
			return row.uuid;
		}
		const refField = this.fields.find(f => f.name === 'Reference');
		const prefix = refField?.groupBy ? (row.symbol.getReference().match(/^[A-Za-z]+/)?.[0] ?? '') : row.uuid;
		const parts = [prefix];
		for (const field of this.fields) {
			if (field.name === 'Reference' || !field.groupBy) {
				continue;
			}
			parts.push(this.getValue(row, field));
		}
		return parts.join('');
	}

	protected buildGroups(rows: SymbolRow[]): GroupRow[] {
		const map = new Map<string, SymbolRow[]>();
		for (const row of rows) {
			const key = this.buildGroupKey(row);
			(map.get(key) ?? map.set(key, []).get(key)!).push(row);
		}
		const groups = [...map.entries()].map(([key, members]) => ({ key, members }));
		for (const group of groups) {
			group.members.sort((a, b) => naturalCompare(a.symbol.getReference(), b.symbol.getReference()));
		}
		groups.sort((a, b) => naturalCompare(a.members[0]!.symbol.getReference(), b.members[0]!.symbol.getReference()));
		return groups;
	}

	// ---- Left field-list panel ----------------------------------------------

	protected addField(): void {
		let n = 1;
		while (this.fields.some(f => f.name === `Field${ n }`)) {
			n++;
		}
		this.fields.push({ name: `Field${ n }`, show: true, groupBy: false, mandatory: false, originalName: null });
		this.renderFieldList();
		this.renderGrid();
	}

	protected deleteField(field: FieldConfig): void {
		this.fields = this.fields.filter(f => f !== field);
		if (field.originalName) {
			this.pendingFieldDeletes.add(field.originalName);
			this.pendingFieldRenames.delete(field.originalName);
		}
		this.renderFieldList();
		this.renderGrid();
	}

	protected renameField(field: FieldConfig, newName: string): void {
		newName = newName.trim();
		if (!newName || newName === field.name) {
			return;
		}
		field.name = newName;
		if (field.originalName) {
			this.pendingFieldRenames.set(field.originalName, newName);
		}
		this.renderGrid();
	}

	protected renderFieldList(): void {
		this.fieldListEl.replaceChildren();
		for (const field of this.fields) {
			const row = document.createElement('div');
			row.className = 'sft-field-row';

			const showCheck = document.createElement('input');
			showCheck.type = 'checkbox';
			showCheck.checked = field.show;
			showCheck.title = 'Include';
			showCheck.addEventListener('change', () => {
				field.show = showCheck.checked;
				this.renderGrid();
				this.renderExportSummary();
			});

			const groupCheck = document.createElement('input');
			groupCheck.type = 'checkbox';
			groupCheck.checked = field.groupBy;
			groupCheck.title = 'Group by';
			groupCheck.addEventListener('change', () => {
				field.groupBy = groupCheck.checked;
				this.renderGrid();
			});

			const nameInput = document.createElement('input');
			nameInput.className = 'sft-field-name';
			nameInput.value = field.name;
			nameInput.readOnly = field.mandatory;
			nameInput.addEventListener('change', () => this.renameField(field, nameInput.value));
			nameInput.addEventListener('keydown', event => {
				if (event.key === 'Enter') {
					this.renameField(field, nameInput.value);
					nameInput.blur();
				}
			});

			row.append(nameInput, showCheck, groupCheck);

			if (!field.mandatory) {
				const del = document.createElement('button');
				del.type = 'button';
				del.className = 'sft-field-delete';
				del.textContent = '✕';
				del.title = 'Delete field';
				del.addEventListener('click', () => this.deleteField(field));
				row.appendChild(del);
			}
			else {
				row.appendChild(document.createElement('span'));
			}

			this.fieldListEl.appendChild(row);
		}
	}

	// ---- Tabs -----------------------------------------------------------------

	protected setActiveTab(tab: 'edit' | 'export'): void {
		this.activeTab = tab;
		this.tabEditEl.classList.toggle('active', tab === 'edit');
		this.tabExportEl.classList.toggle('active', tab === 'export');
		this.panelEditEl.classList.toggle('hidden', tab !== 'edit');
		this.panelExportEl.classList.toggle('hidden', tab !== 'export');
		this.exportBtnEl.disabled = tab !== 'export';
	}

	// ---- Edit-tab grid ----------------------------------------------------------

	protected renderGrid(): void {
		this.gridWrapEl.replaceChildren();
		const columns = this.visibleColumns();
		const rows = this.scopedRows();
		if (!rows.length) {
			const empty = document.createElement('div');
			empty.className = 'sft-empty';
			empty.textContent = this.rows.length ? 'No matching symbols' : 'No symbols found in this schematic.';
			this.gridWrapEl.appendChild(empty);
			return;
		}
		const groups = this.groupSymbols ? this.buildGroups(rows) :
			rows.map(row => ({ key: row.uuid, members: [row] }));

		const table = document.createElement('table');
		table.className = 'sft-grid';
		const thead = document.createElement('thead');
		const headRow = document.createElement('tr');
		headRow.appendChild(document.createElement('th'));
		for (const field of columns) {
			const th = document.createElement('th');
			th.textContent = field.name;
			headRow.appendChild(th);
		}
		thead.appendChild(headRow);
		table.appendChild(thead);

		const tbody = document.createElement('tbody');
		for (const group of groups) {
			tbody.appendChild(this.buildGroupSummaryRow(group, columns));
			if (group.members.length > 1 && this.expandedGroupKeys.has(group.key)) {
				for (const member of group.members) {
					tbody.appendChild(this.buildMemberRow(member, columns));
				}
			}
		}
		table.appendChild(tbody);
		this.gridWrapEl.appendChild(table);
	}

	protected buildGroupSummaryRow(group: GroupRow, columns: FieldConfig[]): HTMLTableRowElement {
		const tr = document.createElement('tr');
		tr.className = 'sft-row sft-row-group';
		const leadCell = document.createElement('td');
		leadCell.className = 'sft-row-lead';
		if (group.members.length > 1) {
			const toggle = document.createElement('button');
			toggle.type = 'button';
			toggle.className = 'sft-expand-toggle';
			toggle.textContent = this.expandedGroupKeys.has(group.key) ? '▼' : '▶';
			toggle.addEventListener('click', () => {
				if (this.expandedGroupKeys.has(group.key)) {
					this.expandedGroupKeys.delete(group.key);
				}
				else {
					this.expandedGroupKeys.add(group.key);
				}
				this.renderGrid();
			});
			leadCell.appendChild(toggle);
		}
		tr.appendChild(leadCell);

		for (const field of columns) {
			const td = document.createElement('td');
			if (field.name === 'Reference') {
				if (group.members.length > 1) {
					td.textContent = group.members.map(m => m.symbol.getReference()).join(', ');
					td.className = 'sft-cell-readonly';
				}
				else {
					td.appendChild(this.buildCellContent(
						field, group.members[0]!, this.getValue(group.members[0]!, field), false,
						value => {
							this.setValue(group.members[0]!, field, value);
							this.renderGrid();
						}
					));
				}
				tr.appendChild(td);
				continue;
			}
			const values = group.members.map(m => this.getValue(m, field));
			const mixed = new Set(values).size > 1;
			td.appendChild(this.buildCellContent(
				field, group.members[0]!, mixed ? '' : values[0]!, mixed,
				value => {
					for (const member of group.members) {
						this.setValue(member, field, value);
					}
					this.renderGrid();
				}
			));
			tr.appendChild(td);
		}
		return tr;
	}

	protected buildMemberRow(row: SymbolRow, columns: FieldConfig[]): HTMLTableRowElement {
		const tr = document.createElement('tr');
		tr.className = 'sft-row sft-row-member';
		tr.appendChild(document.createElement('td'));
		for (const field of columns) {
			const td = document.createElement('td');
			td.appendChild(this.buildCellContent(
				field, row, this.getValue(row, field), false,
				value => {
					this.setValue(row, field, value);
					this.renderGrid();
				}
			));
			tr.appendChild(td);
		}
		return tr;
	}

	/** Wraps buildCellInput with a "…" browse button for the Footprint
	 *  column, matching the same button this app's other symbol-editing
	 *  surfaces (sidebar Properties panel, Fields-grid modal) already give
	 *  Footprint — opens the existing FootprintChooser, seeded with
	 *  ki_fp_filters/pin-count resolved from contextRow's own library
	 *  definition (resolveLibSymbolFor). `contextRow` is the group's first
	 *  member for a collapsed multi-symbol row — a reasonable default since
	 *  different members of a group could in principle have different
	 *  filter data, but picking a footprint still applies to every member
	 *  via the same onCommit every other grouped-cell edit already uses. */
	protected buildCellContent(
		field: FieldConfig, contextRow: SymbolRow, displayValue: string, mixed: boolean,
		onCommit: (value: string) => void
	): HTMLElement {
		const input = this.buildCellInput(displayValue, mixed, onCommit);
		if (field.name !== 'Footprint') {
			return input;
		}
		const wrap = document.createElement('div');
		wrap.className = 'sft-cell-with-button';
		const browse = document.createElement('button');
		browse.type = 'button';
		browse.className = 'sft-cell-browse-btn';
		browse.textContent = '…';
		browse.title = 'Browse…';
		browse.addEventListener('click', () => {
			const libDef = this.resolveLibSymbolFor(contextRow);
			void this.callbacks.openFootprintChooser({
				fpFilters: libDef?.getFPFilters() ?? [], pinCount: libDef?.getPinCount() ?? 0
			}).then(fpId => {
				if (fpId) {
					onCommit(fpId);
				}
			});
		});
		wrap.append(input, browse);
		return wrap;
	}

	protected buildCellInput(
		displayValue: string, mixed: boolean, onCommit: (value: string) => void): HTMLInputElement {
		const input = document.createElement('input');
		input.className = `sft-cell-input${ mixed ? ' sft-mixed' : '' }`;
		input.value = mixed ? '-- mixed values --' : displayValue;
		let dirty = false;
		input.addEventListener('input', () => {
			dirty = true;
			input.classList.remove('sft-mixed');
		});
		const commit = () => {
			if (dirty) {
				onCommit(input.value);
				dirty = false;
			}
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				commit();
				input.blur();
			}
		});
		return input;
	}

	// ---- Export tab ---------------------------------------------------------------

	protected renderExportSummary(): void {
		const rows = this.scopedRows();
		const groups = this.groupSymbols ? this.buildGroups(rows) :
			rows.map(row => ({ key: row.uuid, members: [row] }));
		const columns = this.visibleColumns();
		this.exportSummaryEl.textContent = `${ groups.length } row${ groups.length === 1 ? '' : 's' } `
			+ `(${ rows.length } symbol${ rows.length === 1 ? '' : 's' }), ${ columns.length } column${ columns.length
			=== 1 ? '' : 's' } `
			+ `will be exported using the field list and scope on the left.`;
	}

	protected buildCsv(): string {
		const columns = this.visibleColumns();
		const rows = this.scopedRows();
		const groups = this.groupSymbols ? this.buildGroups(rows) :
			rows.map(row => ({ key: row.uuid, members: [row] }));
		const header = [...columns.map(f => f.name), 'Qty'].map(csvEscape).join(',');
		const lines = [header];
		for (const group of groups) {
			const cells = columns.map(field => {
				if (field.name === 'Reference') {
					return csvEscape(group.members.map(m => m.symbol.getReference()).join(', '));
				}
				const values = [...new Set(group.members.map(m => this.getValue(m, field)).filter(v => v !== ''))];
				return csvEscape(values.join(', '));
			});
			cells.push(String(group.members.length));
			lines.push(cells.join(','));
		}
		return lines.join('\r\n');
	}

	protected downloadCsv(): void {
		const csv = this.buildCsv();
		const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'symbol-fields.csv';
		a.click();
		URL.revokeObjectURL(url);
	}

	// ---- Commit (Apply / OK) -------------------------------------------------------

	/** Flushes buffered edits into the AST, resyncs the live render session
	 *  if the currently-open sheet was touched (see the plan's write-back
	 *  section for why this step is load-bearing), then persists via the
	 *  existing saveProject() — no new file-writing logic needed. */
	protected async commit(closeAfter: boolean): Promise<void> {
		const touchedSheets = new Set<KicadSchematic>();

		for (const originalName of this.pendingFieldDeletes) {
			for (const row of this.rows) {
				if (row.symbol.getPropertyByName(originalName)) {
					row.symbol.deleteProperty(originalName);
					touchedSheets.add(row.sheet);
				}
			}
		}
		for (const [originalName, newName] of this.pendingFieldRenames) {
			if (this.pendingFieldDeletes.has(originalName)) {
				continue;
			}
			for (const row of this.rows) {
				const prop = row.symbol.getPropertyByName(originalName);
				if (prop) {
					const value = prop.propertyValue;
					row.symbol.deleteProperty(originalName);
					row.symbol.setProperty(newName, value ?? '');
					touchedSheets.add(row.sheet);
				}
			}
		}
		for (const [uuid, edits] of this.pendingEdits) {
			const row = this.rows.find(r => r.uuid === uuid);
			if (!row) {
				continue;
			}
			for (const [name, value] of edits) {
				row.symbol.setProperty(name, value);
			}
			touchedSheets.add(row.sheet);
		}

		if (touchedSheets.size === 0) {
			this.pendingEdits.clear();
			this.pendingFieldDeletes.clear();
			this.pendingFieldRenames.clear();
			if (closeAfter) {
				this.close();
			}
			return;
		}

		const session = this.callbacks.getSession();
		const currentSheet = this.callbacks.getCurrentSheetNode();
		if (session && currentSheet && touchedSheets.has(currentSheet) && currentSheet.rootElement) {
			await session.resyncSchematicFromAst(currentSheet.rootElement.write() + '\n');
		}

		await this.callbacks.saveProject();
		this.callbacks.refreshSidebar();
		this.callbacks.setStatus('Symbol fields updated.');

		this.load();
		if (closeAfter) {
			this.close();
		}
	}
}
