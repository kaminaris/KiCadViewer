import type { ProjectContext } from '../app/ProjectContext';
import type { KicadLayerType } from '@kicad-io/KicadElementLayers';
import type { KicadElementEmbeddedFile } from '@kicad-io/KicadElementEmbeddedFiles';
import { mmh3Hash128Hex } from '@kicad-io/Project/EmbeddedFileHash';
import { decompress } from '@zstd-ts/decode';
import {
	ProjectSettingsDraft,
	type BomFieldRecord,
	type BomFormatPresetRecord,
	type BomPresetRecord,
	type ComponentClassAssignment,
	type DiffPairDimensionRecord,
	type FieldNameTemplateRecord,
	type NetClassRecord,
	type TuningProfileRecord,
	type TeardropParameterRecord,
	type ViaDimensionRecord,
	type ValidationIssue
} from './ProjectSettingsDraft';

type PageId = 'text-variables' | 'net-classes' | string;

interface PageDefinition {
	id: PageId;
	label: string;
	group: 'Project' | 'Schematic' | 'Board';
	phase: number;
}

const PAGES: readonly PageDefinition[] = [
	{ id: 'net-classes', label: 'Net Classes', group: 'Project', phase: 2 },
	{ id: 'component-classes', label: 'Component Classes', group: 'Project', phase: 2 },
	{ id: 'tuning-profiles', label: 'Tuning Profiles', group: 'Project', phase: 2 },
	{ id: 'text-variables', label: 'Text Variables', group: 'Project', phase: 2 },
	{ id: 'bus-aliases', label: 'Bus Alias Definitions', group: 'Project', phase: 2 },
	{ id: 'net-chains', label: 'Net Chains', group: 'Project', phase: 2 },
	{ id: 'libraries', label: 'Libraries', group: 'Project', phase: 2 },
	{ id: 'schematic-formatting', label: 'General / Formatting', group: 'Schematic', phase: 3 },
	{ id: 'schematic-annotation', label: 'General / Annotation', group: 'Schematic', phase: 3 },
	{ id: 'field-templates', label: 'General / Field Name Templates', group: 'Schematic', phase: 3 },
	{ id: 'bom-presets', label: 'General / BOM Presets', group: 'Schematic', phase: 3 },
	{ id: 'erc-severity', label: 'Electrical Rules / Violation Severity', group: 'Schematic', phase: 3 },
	{ id: 'pin-conflicts', label: 'Electrical Rules / Pin Conflicts Map', group: 'Schematic', phase: 3 },
	{ id: 'schematic-embedded', label: 'Schematic Data / Embedded Files', group: 'Schematic', phase: 6 },
	{ id: 'board-layers', label: 'Board Stackup / Board Editor Layers', group: 'Board', phase: 5 },
	{ id: 'physical-stackup', label: 'Board Stackup / Physical Stackup', group: 'Board', phase: 5 },
	{ id: 'board-finish', label: 'Board Stackup / Board Finish', group: 'Board', phase: 5 },
	{ id: 'mask-paste', label: 'Board Stackup / Solder Mask/Paste', group: 'Board', phase: 5 },
	{ id: 'board-defaults', label: 'Text & Graphics / Defaults', group: 'Board', phase: 4 },
	{ id: 'board-formatting', label: 'Text & Graphics / Formatting', group: 'Board', phase: 4 },
	{ id: 'board-constraints', label: 'Design Rules / Constraints', group: 'Board', phase: 4 },
	{ id: 'predefined-sizes', label: 'Design Rules / Pre-defined Sizes', group: 'Board', phase: 4 },
	{ id: 'zone-defaults', label: 'Design Rules / Zones', group: 'Board', phase: 4 },
	{ id: 'teardrops', label: 'Design Rules / Teardrops', group: 'Board', phase: 4 },
	{ id: 'length-tuning', label: 'Design Rules / Length-tuning Patterns', group: 'Board', phase: 4 },
	{ id: 'custom-rules', label: 'Design Rules / Custom Rules', group: 'Board', phase: 6 },
	{ id: 'drc-severity', label: 'Design Rules / Violation Severity', group: 'Board', phase: 4 },
	{ id: 'board-embedded', label: 'Board Data / Embedded Files', group: 'Board', phase: 6 }
];

const IMPLEMENTED_PAGES = new Set<PageId>([
	'text-variables', 'net-classes', 'component-classes', 'tuning-profiles',
	'bus-aliases', 'net-chains', 'libraries', 'schematic-formatting',
	'schematic-annotation', 'field-templates', 'bom-presets', 'erc-severity',
	'pin-conflicts', 'board-layers', 'physical-stackup', 'board-finish', 'mask-paste',
	'board-defaults', 'board-formatting', 'board-constraints',
	'predefined-sizes', 'zone-defaults', 'teardrops', 'length-tuning',
	'drc-severity', 'custom-rules', 'board-embedded', 'schematic-embedded'
]);

const EMBEDDED_FILE_TYPE_BY_EXTENSION: Record<string, string> = {
	step: 'model', stp: 'model', wrl: 'model',
	ttf: 'font', otf: 'font',
	kicad_wks: 'worksheet',
	pdf: 'datasheet'
};

function guessEmbeddedFileType(filename: string): string {
	const match = /\.([^.]+)$/.exec(filename);
	const extension = match?.[1]?.toLowerCase();
	return (extension && EMBEDDED_FILE_TYPE_BY_EXTENSION[extension]) || 'other';
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${ bytes } B`;
	if (bytes < 1024 * 1024) return `${ (bytes / 1024).toFixed(1) } KB`;
	return `${ (bytes / (1024 * 1024)).toFixed(1) } MB`;
}

export interface ProjectSetupControllerDeps {
	setStatus(message: string): void;
	/** boardChanged is true when the applied draft wrote a new .kicad_pcb, so the caller can refresh the live board session. */
	onApplied(boardChanged: boolean): void;
	onCategoryChange?(category: string): void;
}

function normalizePageId(value: string | null | undefined): PageId {
	if (value && PAGES.some(item => item.id === value)) {
		return value;
	}
	return 'net-classes';
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
	const element = document.createElement('button');
	element.type = 'button';
	element.className = className;
	element.textContent = label;
	element.addEventListener('click', onClick);
	return element;
}

function textInput(value: string, onInput: (value: string) => void): HTMLInputElement {
	const input = document.createElement('input');
	input.type = 'text';
	input.value = value;
	input.addEventListener('input', () => onInput(input.value));
	return input;
}

function textareaInput(value: string, onInput: (value: string) => void): HTMLTextAreaElement {
	const textarea = document.createElement('textarea');
	textarea.value = value;
	textarea.spellcheck = false;
	textarea.addEventListener('input', () => onInput(textarea.value));
	return textarea;
}

function numberInput(value: unknown, onInput: (value: number) => void, step = '0.01', min: string | null = '0'): HTMLInputElement {
	const input = document.createElement('input');
	input.type = 'number';
	if (min !== null) input.min = min;
	input.step = step;
	input.value = typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
	input.addEventListener('input', () => onInput(Number(input.value)));
	return input;
}

function selectInput(
	value: string | number,
	options: ReadonlyArray<readonly [string, string | number]>,
	onChange: (value: string) => void
): HTMLSelectElement {
	const select = document.createElement('select');
	for (const [label, optionValue] of options) select.append(new Option(label, String(optionValue)));
	select.value = String(value);
	select.addEventListener('change', () => onChange(select.value));
	return select;
}

function checkboxInput(checked: boolean, labelText: string, onChange: (checked: boolean) => void): HTMLLabelElement {
	const label = document.createElement('label');
	label.className = 'project-settings-checkbox';
	const checkbox = document.createElement('input');
	checkbox.type = 'checkbox';
	checkbox.checked = checked;
	checkbox.addEventListener('change', () => onChange(checkbox.checked));
	label.append(checkbox, document.createTextNode(labelText));
	return label;
}

const KICAD_COLOR_UNSET = 'rgba(0, 0, 0, 0.000)';

/** .kicad_pro color strings: rgba(0, 0, 0, 0.000) means "unset", rgb(r, g, b) (no alpha) means a real user pick. */
function kicadColorToHex(value: string | null | undefined): string | null {
	if (!value) return null;
	const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
	if (match) return `#${ [match[1], match[2], match[3]].map(channel => Number(channel).toString(16).padStart(2, '0')).join('') }`;
	return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function hexToKicadColor(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgb(${ r }, ${ g }, ${ b })`;
}

/** A native color picker plus a Clear link, using the .kicad_pro rgb(a) string convention. */
function colorInput(value: string, onChange: (value: string) => void): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'project-settings-color';
	const picker = document.createElement('input');
	picker.type = 'color';
	picker.value = kicadColorToHex(value) ?? '#808080';
	picker.addEventListener('input', () => onChange(hexToKicadColor(picker.value)));
	wrap.append(picker, button('Clear', 'danger-link', () => {
		picker.value = '#000000';
		onChange(KICAD_COLOR_UNSET);
	}));
	return wrap;
}

// pcbnew/board_stackup_manager/stackup_predefined_prms.cpp: GetStandardColors() — used for Silkscreen/Soldermask items.
const GBRJOB_COLORS: ReadonlyArray<readonly [string, string]> = [
	['Not specified', '#505050'], ['Green', '#3c9650'], ['Red', '#800000'], ['Blue', '#000080'],
	['Purple', '#500050'], ['Black', '#141414'], ['White', '#c8c8c8'], ['Yellow', '#808000']
];

// Same source: dielectric-item predefined colors.
const DIELECTRIC_COLORS: ReadonlyArray<readonly [string, string]> = [
	['Not specified', '#505050'], ['FR4 natural', '#6d744b'], ['PTFE natural', '#fcfcfa'],
	['Polyimide', '#cd8200'], ['Phenolic natural', '#5c1106'], ['Aluminum', '#d5d5d5']
];

// pcbnew/board_stackup_manager/dielectric_material.cpp: substrateMaterial/solderMaskMaterial/silkscreenMaterial.
const DIELECTRIC_MATERIALS: ReadonlyArray<readonly [string, number, number]> = [
	['Not specified', 0, 0], ['FR4', 4.5, 0.02], ['FR408-HR', 3.69, 0.0091], ['Polyimide', 3.2, 0.004],
	['Kapton', 3.2, 0.004], ['Polyolefin', 1.0, 0], ['Al', 8.7, 0.001], ['PTFE', 2.1, 0.0002],
	['Teflon', 2.1, 0.0002], ['Ceramic', 1.0, 0]
];
const SOLDERMASK_MATERIALS: ReadonlyArray<readonly [string, number, number]> = [
	['Not specified', 3.3, 0], ['Epoxy', 3.3, 0], ['Liquid Ink', 3.3, 0], ['Dry Film', 3.3, 0]
];
const SILKSCREEN_MATERIALS: ReadonlyArray<readonly [string, number, number]> = [
	['Not specified', 1.0, 0], ['Liquid Photo', 1.0, 0], ['Direct Printing', 1.0, 0]
];

type StackupRowKind = 'dielectric' | 'copper' | 'soldermask' | 'silkscreen' | 'other';

/** pcbnew/board_stackup_manager/board_stackup.cpp: IsMaterialEditable()/IsColorEditable() are true only for these three kinds. */
function stackupRowKind(row: { name: string; type: string }): StackupRowKind {
	if (/^dielectric\s+/i.test(row.name)) return 'dielectric';
	const type = row.type.toLowerCase();
	if (type === 'copper') return 'copper';
	if (type.includes('solder mask')) return 'soldermask';
	if (type.includes('silk screen')) return 'silkscreen';
	return 'other';
}

interface MaterialDialogResult { name: string; epsilonR: number; lossTangent: number }

/**
 * pcbnew/board_stackup_manager/panel_board_stackup.cpp's onMaterialChange: "Ensure m_materialList
 * contains all materials already in use in stackup list" — the predefined list plus any material
 * from another row of the same kind that isn't already present (matched by name+εr+tanδ, like
 * DIELECTRIC_SUBSTRATE_LIST::FindSubstrate), so distinct real-world values under the same name
 * (e.g. two different "FR4" mixes) both show up.
 */
function materialsInUse(
	rows: ReadonlyArray<{ name: string; type: string; material?: string; epsilonR?: number; lossTangent?: number }>,
	kind: StackupRowKind, predefined: ReadonlyArray<readonly [string, number, number]>
): ReadonlyArray<readonly [string, number, number]> {
	const result = [...predefined];
	for (const row of rows) {
		if (stackupRowKind(row) !== kind || !row.material) continue;
		const epsilonR = row.epsilonR ?? 0;
		const lossTangent = row.lossTangent ?? 0;
		const exists = result.some(([name, e, l]) => name.toLowerCase() === row.material!.toLowerCase() && e === epsilonR && l === lossTangent);
		if (!exists) result.push([row.material, epsilonR, lossTangent]);
	}
	return result;
}

/** pcbnew/board_stackup_manager/dialog_dielectric_list_manager.cpp+.fbp: DIALOG_DIELECTRIC_MATERIAL. */
function openMaterialDialog(
	materials: ReadonlyArray<readonly [string, number, number]>,
	current: MaterialDialogResult,
	onConfirm: (result: MaterialDialogResult) => void
): void {
	const backdrop = document.createElement('div');
	backdrop.className = 'material-dialog-backdrop';
	const dialog = document.createElement('div');
	dialog.className = 'material-dialog';

	const heading = document.createElement('h3');
	heading.textContent = 'Dielectric Material Characteristics';

	const fields = document.createElement('div');
	fields.className = 'material-dialog-fields';
	const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.value = current.name;
	const epsilonInput = document.createElement('input'); epsilonInput.type = 'text'; epsilonInput.value = String(current.epsilonR);
	const lossInput = document.createElement('input'); lossInput.type = 'text'; lossInput.value = String(current.lossTangent);
	for (const [labelText, input] of [['Name:', nameInput], ['Epsilon R:', epsilonInput], ['Loss Tan:', lossInput]] as const) {
		const label = document.createElement('label');
		const caption = document.createElement('span'); caption.textContent = labelText;
		label.append(caption, input);
		fields.append(label);
	}

	const listHeading = document.createElement('p');
	listHeading.className = 'material-dialog-list-heading';
	listHeading.textContent = 'Common materials:';
	const table = document.createElement('table');
	table.className = 'project-settings-table';
	table.innerHTML = '<thead><tr><th>Material</th><th>Epsilon R</th><th>Loss Tan</th></tr></thead>';
	const body = document.createElement('tbody');
	for (const [name, epsilonR, lossTangent] of materials) {
		const tr = document.createElement('tr');
		tr.className = 'material-dialog-row';
		const nameCell = document.createElement('td'); nameCell.textContent = name;
		const epsilonCell = document.createElement('td'); epsilonCell.textContent = String(epsilonR);
		const lossCell = document.createElement('td'); lossCell.textContent = String(lossTangent);
		tr.append(nameCell, epsilonCell, lossCell);
		tr.addEventListener('click', () => {
			nameInput.value = name;
			epsilonInput.value = String(epsilonR);
			lossInput.value = String(lossTangent);
		});
		body.append(tr);
	}
	table.append(body);
	const listWrap = document.createElement('div');
	listWrap.className = 'material-dialog-list';
	listWrap.append(table);

	const actions = document.createElement('div');
	actions.className = 'table-modal-actions';
	actions.append(
		button('Cancel', '', () => backdrop.remove()),
		button('OK', 'primary', () => {
			// Mirrors TransferDataFromWindow(): both values must parse as non-negative doubles.
			const epsilonR = Number(epsilonInput.value);
			const lossTangent = Number(lossInput.value);
			if (!Number.isFinite(epsilonR) || epsilonR < 0) { window.alert('Incorrect value for Epsilon R'); return; }
			if (!Number.isFinite(lossTangent) || lossTangent < 0) { window.alert('Incorrect value for Loss Tangent'); return; }
			onConfirm({ name: nameInput.value, epsilonR, lossTangent });
			backdrop.remove();
		})
	);

	dialog.append(heading, fields, listHeading, listWrap, actions);
	backdrop.append(dialog);
	backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) backdrop.remove(); });
	document.body.append(backdrop);
	nameInput.focus();
}

/**
 * .kicad_pcb stackup color: a predefined name string (e.g. "FR4 natural"), or a "#RRGGBBAA" hex
 * string for a user-defined color (panel_board_stackup.cpp's "starts with # = custom" rule).
 *
 * Mirrors createColorBox()'s wxBitmapComboBox: a trigger showing a color swatch + label, a popup
 * list with a swatch per predefined color, and a last "User defined" entry that immediately opens
 * a color picker (like onColorSelected's dlg.ShowModal()) instead of revealing an inline control.
 */
function stackupColorCell(value: string | undefined, predefined: ReadonlyArray<readonly [string, string]>, onChange: (value: string) => void): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'stackup-color-combo';

	const trigger = document.createElement('button');
	trigger.type = 'button';
	trigger.className = 'stackup-color-trigger';
	const triggerSwatch = document.createElement('span'); triggerSwatch.className = 'stackup-color-swatch';
	const triggerLabel = document.createElement('span'); triggerLabel.className = 'stackup-color-label';
	const triggerCaret = document.createElement('span'); triggerCaret.className = 'stackup-color-caret'; triggerCaret.textContent = '▾';
	trigger.append(triggerSwatch, triggerLabel, triggerCaret);

	const menu = document.createElement('div');
	menu.className = 'stackup-color-menu hidden';

	const nativeInput = document.createElement('input');
	nativeInput.type = 'color';
	nativeInput.className = 'stackup-color-native';

	function isCustom(current: string | undefined): boolean { return (current ?? '').startsWith('#'); }
	function customHex(current: string | undefined): string { return isCustom(current) ? current!.slice(0, 7) : '#808080'; }

	function onDocClick(event: MouseEvent): void {
		if (!wrap.contains(event.target as Node)) closeMenu();
	}
	function closeMenu(): void {
		menu.classList.add('hidden');
		document.removeEventListener('mousedown', onDocClick, true);
	}
	function updateTrigger(current: string | undefined): void {
		const custom = isCustom(current);
		const matchedName = predefined.find(([name]) => name.toLowerCase() === (current ?? '').toLowerCase())?.[0];
		triggerLabel.textContent = custom ? current!.toUpperCase() : (matchedName ?? 'Not specified');
		triggerSwatch.style.background = custom ? customHex(current) : (predefined.find(([name]) => name === (matchedName ?? 'Not specified'))?.[1] ?? '#505050');
		customOptionSwatch.style.background = customHex(current);
		customOptionLabel.textContent = custom ? current!.toUpperCase() : 'User defined';
	}

	for (const [name, hex] of predefined) {
		const option = document.createElement('button');
		option.type = 'button';
		option.className = 'stackup-color-option';
		const swatch = document.createElement('span'); swatch.className = 'stackup-color-swatch'; swatch.style.background = hex;
		const label = document.createElement('span'); label.textContent = name;
		option.append(swatch, label);
		option.addEventListener('click', () => { onChange(name); updateTrigger(name); closeMenu(); });
		menu.append(option);
	}

	const customOption = document.createElement('button');
	customOption.type = 'button';
	customOption.className = 'stackup-color-option';
	const customOptionSwatch = document.createElement('span'); customOptionSwatch.className = 'stackup-color-swatch';
	const customOptionLabel = document.createElement('span');
	customOption.append(customOptionSwatch, customOptionLabel);
	customOption.addEventListener('click', () => { nativeInput.value = customHex(value); nativeInput.click(); });
	menu.append(customOption);

	nativeInput.addEventListener('input', () => {
		const hex = `${ nativeInput.value }FF`.toUpperCase();
		value = hex;
		onChange(hex);
		updateTrigger(hex);
		closeMenu();
	});

	trigger.addEventListener('click', () => {
		const willOpen = menu.classList.contains('hidden');
		if (willOpen) { menu.classList.remove('hidden'); document.addEventListener('mousedown', onDocClick, true); }
		else closeMenu();
	});

	updateTrigger(value);
	wrap.append(trigger, menu, nativeInput);
	return wrap;
}

export class ProjectSetupController {
	protected context: ProjectContext | null = null;
	protected draft: ProjectSettingsDraft | null = null;
	protected page: PageId = 'net-classes';
	protected selectedNetClass = 0;
	protected textVariableRows: Array<{ name: string; value: string }> = [];
	protected assignmentRows: Array<{ net: string; netclass: string }> = [];
	protected netColorRows: Array<{ net: string; color: string }> = [];
	protected busAliasRows: Array<{ name: string; members: string }> = [];
	protected netChainRows: Array<{ chain: string; netclass: string }> = [];
	protected symbolLibraryRows: string[] = [];
	protected footprintLibraryRows: string[] = [];
	protected uiIssues: ValidationIssue[] = [];
	protected navEl!: HTMLElement;
	protected contentEl!: HTMLElement;
	protected applyButton!: HTMLButtonElement;
	protected revertButton!: HTMLButtonElement;
	protected dirtyEl!: HTMLElement;

	constructor(
		protected readonly root: HTMLElement,
		protected readonly deps: ProjectSetupControllerDeps
	) {
		window.addEventListener('beforeunload', event => {
			if (!this.isDirty) return;
			event.preventDefault();
		});
	}

	get isDirty(): boolean {
		return !!this.draft?.isDirty || this.hasPendingLocalRows() || this.validateLocalRows().length > 0;
	}

	activate(context: ProjectContext, requestedPage?: string | null): void {
		if (requestedPage) {
			this.page = normalizePageId(requestedPage);
		}
		if (this.context?.key !== context.key || !this.draft) {
			const projectFile = context.project.projectFile;
			if (!projectFile) throw new Error('This project has no .kicad_pro file.');
			this.context = context;
			this.draft = new ProjectSettingsDraft(
				projectFile.raw, context.project.mainBoard, context.project.designRules, context.project.mainSchematic
			);
			this.syncLocalRows();
		}
		this.root.classList.remove('hidden');
		this.renderShell();
	}

	deactivate(): void {
		this.root.classList.add('hidden');
	}

	requestLeave(): boolean {
		if (!this.isDirty) return true;
		if (!window.confirm('Discard unapplied Project Setup changes?')) return false;
		this.draft?.reset();
		this.syncLocalRows();
		return true;
	}

	protected syncLocalRows(): void {
		this.textVariableRows = Object.entries(this.draft?.textVariables ?? {}).map(([name, value]) => ({ name, value }));
		this.assignmentRows = Object.entries(this.draft?.netClassAssignments ?? {})
			.flatMap(([net, netclasses]) => netclasses.map(netclass => ({ net, netclass })));
		this.netColorRows = Object.entries(this.draft?.netColors ?? {}).map(([net, color]) => ({ net, color }));
		this.busAliasRows = Object.entries(this.draft?.busAliases ?? {})
			.map(([name, members]) => ({ name, members: members.join(', ') }));
		this.netChainRows = Object.entries(this.draft?.netChainClasses ?? {})
			.map(([chain, netclass]) => ({ chain, netclass }));
		this.symbolLibraryRows = [...(this.draft?.pinnedSymbolLibraries ?? [])];
		this.footprintLibraryRows = [...(this.draft?.pinnedFootprintLibraries ?? [])];
		this.uiIssues = [];
	}

	protected renderShell(): void {
		this.root.replaceChildren();
		const header = document.createElement('header');
		header.className = 'project-setup-header';
		const titleWrap = document.createElement('div');
		const title = document.createElement('h1');
		title.textContent = 'Project Setup';
		const subtitle = document.createElement('p');
		subtitle.textContent = this.context?.project.projectFile?.name || this.context?.rootName || '';
		titleWrap.append(title, subtitle);
		this.dirtyEl = document.createElement('span');
		this.dirtyEl.className = 'project-setup-dirty';
		header.append(titleWrap, this.dirtyEl);

		const body = document.createElement('div');
		body.className = 'project-setup-body';
		this.navEl = document.createElement('nav');
		this.navEl.className = 'project-setup-nav';
		this.navEl.setAttribute('aria-label', 'Project setup pages');
		this.contentEl = document.createElement('div');
		this.contentEl.className = 'project-setup-content';
		body.append(this.navEl, this.contentEl);

		const footer = document.createElement('footer');
		footer.className = 'project-setup-footer';
		const note = document.createElement('span');
		note.textContent = this.context?.readOnly ? 'Read-only project' : 'Changes are written to the KiCad project when applied.';
		const actions = document.createElement('div');
		this.revertButton = button('Revert', '', () => this.revert());
		this.applyButton = button('Apply', 'primary', () => { void this.apply(); });
		actions.append(this.revertButton, this.applyButton);
		footer.append(note, actions);
		this.root.append(header, body, footer);
		this.renderNavigation();
		this.renderPage();
		this.updateChrome();
	}

	protected renderNavigation(): void {
		this.navEl.replaceChildren();
		const search = document.createElement('input');
		search.type = 'search';
		search.placeholder = 'Search settings…';
		search.className = 'project-setup-search';
		this.navEl.append(search);
		const list = document.createElement('div');
		list.className = 'project-setup-nav-list';
		this.navEl.append(list);

		const draw = (): void => {
			list.replaceChildren();
			const query = search.value.trim().toLowerCase();
			for (const group of ['Project', 'Schematic', 'Board'] as const) {
				const pages = PAGES.filter(item => item.group === group && (!query || `${ item.group } ${ item.label }`.toLowerCase().includes(query)));
				if (!pages.length) continue;
				const heading = document.createElement('h2');
				heading.textContent = group;
				list.append(heading);
				for (const item of pages) {
					const pageButton = button(item.label, 'project-setup-nav-item', () => {
						this.page = normalizePageId(item.id);
						this.deps.onCategoryChange?.(this.page);
						for (const other of list.querySelectorAll('.project-setup-nav-item')) {
							other.classList.toggle('active', other === pageButton);
						}
						this.renderPage();
					});
					pageButton.classList.toggle('active', this.page === item.id);
					if (!IMPLEMENTED_PAGES.has(item.id)) pageButton.classList.add('planned');
					list.append(pageButton);
				}
			}
		};
		search.addEventListener('input', draw);
		draw();
	}

	protected renderPage(): void {
		this.contentEl.replaceChildren();
		if (this.page === 'text-variables') this.renderTextVariables();
		else if (this.page === 'net-classes') this.renderNetClasses();
		else if (this.page === 'bus-aliases') this.renderBusAliases();
		else if (this.page === 'net-chains') this.renderNetChains();
		else if (this.page === 'libraries') this.renderLibraries();
		else if (this.page === 'component-classes') this.renderComponentClasses();
		else if (this.page === 'tuning-profiles') this.renderTuningProfiles();
		else if (this.page === 'schematic-formatting') this.renderSchematicFormatting();
		else if (this.page === 'schematic-annotation') this.renderSchematicAnnotation();
		else if (this.page === 'field-templates') this.renderFieldNameTemplates();
		else if (this.page === 'bom-presets') this.renderBomPresets();
		else if (this.page === 'erc-severity') this.renderErcSeverity();
		else if (this.page === 'pin-conflicts') this.renderPinConflicts();
		else if (this.page === 'board-layers') this.renderBoardLayers();
		else if (this.page === 'physical-stackup') this.renderPhysicalStackup();
		else if (this.page === 'board-finish') this.renderBoardFinish();
		else if (this.page === 'mask-paste') this.renderMaskPaste();
		else if (this.page === 'board-defaults') this.renderBoardDefaults();
		else if (this.page === 'board-formatting') this.renderBoardFormatting();
		else if (this.page === 'board-constraints') this.renderBoardConstraints();
		else if (this.page === 'predefined-sizes') this.renderPredefinedSizes();
		else if (this.page === 'zone-defaults') this.renderZoneDefaults();
		else if (this.page === 'teardrops') this.renderTeardrops();
		else if (this.page === 'length-tuning') this.renderLengthTuning();
		else if (this.page === 'drc-severity') this.renderDrcSeverity();
		else if (this.page === 'custom-rules') this.renderCustomRules();
		else if (this.page === 'board-embedded') this.renderEmbeddedFilesPage('board');
		else if (this.page === 'schematic-embedded') this.renderEmbeddedFilesPage('schematic');
		else this.renderPlannedPage();
	}

	protected pageHeading(titleText: string, description: string): void {
		const header = document.createElement('div');
		header.className = 'project-setup-page-heading';
		const title = document.createElement('h2');
		title.textContent = titleText;
		const text = document.createElement('p');
		text.textContent = description;
		header.append(title, text);
		this.contentEl.append(header);
	}

	protected renderTextVariables(): void {
		this.pageHeading('Text Variables', 'Project-wide variables used as ${NAME} in schematic and PCB text.');
		const table = document.createElement('table');
		table.className = 'project-settings-table';
		table.innerHTML = '<thead><tr><th>Name</th><th>Value</th><th></th></tr></thead>';
		const body = document.createElement('tbody');
		this.textVariableRows.forEach((row, index) => {
			const tr = document.createElement('tr');
			const nameCell = document.createElement('td');
			nameCell.append(textInput(row.name, value => { row.name = value; this.commitTextVariableRows(); }));
			const valueCell = document.createElement('td');
			valueCell.append(textInput(row.value, value => { row.value = value; this.commitTextVariableRows(); }));
			const actionCell = document.createElement('td');
			actionCell.append(button('Remove', 'danger-link', () => {
				this.textVariableRows.splice(index, 1);
				this.commitTextVariableRows();
				this.renderPage();
			}));
			tr.append(nameCell, valueCell, actionCell);
			body.append(tr);
		});
		table.append(body);
		this.contentEl.append(table, button('Add Text Variable', '', () => {
			this.textVariableRows.push({ name: `VARIABLE_${ this.textVariableRows.length + 1 }`, value: '' });
			this.commitTextVariableRows();
			this.renderPage();
		}));
		this.renderIssues();
	}

	protected commitTextVariableRows(): void {
		if (!this.validateLocalRows().some(issue => issue.path === 'text_variables')) {
			this.draft?.setTextVariables(this.textVariableRows);
		}
		this.updateChrome();
		this.renderIssues();
	}

	protected renderNetClasses(): void {
		const draft = this.draft!;
		this.pageHeading('Net Classes', 'Shared schematic and PCB electrical, routing, color, and tuning defaults.');
		const layout = document.createElement('div');
		layout.className = 'netclass-layout';
		const list = document.createElement('div');
		list.className = 'netclass-list';
		draft.netClasses.forEach((netClass, index) => {
			const item = button(netClass.name || '(unnamed)', 'netclass-list-item', () => {
				this.selectedNetClass = index;
				this.renderPage();
			});
			item.classList.toggle('active', index === this.selectedNetClass);
			list.append(item);
		});
		list.append(button('Add Net Class', '', () => {
			draft.addNetClass();
			this.selectedNetClass = draft.netClasses.length - 1;
			this.changed();
			this.renderPage();
		}));
		layout.append(list);

		if (draft.netClasses.length) {
			this.selectedNetClass = Math.min(this.selectedNetClass, draft.netClasses.length - 1);
			layout.append(this.renderNetClassForm(draft.netClasses[this.selectedNetClass]!, this.selectedNetClass));
		}
		this.contentEl.append(layout);
		this.renderPatternTable();
		this.renderAssignmentTable();
		this.renderNetColorTable();
		this.renderIssues();
	}

	protected renderNetClassForm(netClass: NetClassRecord, index: number): HTMLElement {
		const form = document.createElement('div');
		form.className = 'netclass-form';
		const addField = (labelText: string, input: HTMLElement): void => {
			const label = document.createElement('label');
			const caption = document.createElement('span');
			caption.textContent = labelText;
			label.append(caption, input);
			form.append(label);
		};
		addField('Name', textInput(netClass.name, value => { netClass.name = value; this.changed(); }));
		addField('Priority', numberInput(netClass.priority, value => { netClass.priority = value; this.changed(); }, '1'));
		const groups: Array<[string, Array<[string, keyof NetClassRecord, string?]>]> = [
			['PCB routing (mm)', [
				['Clearance', 'clearance'], ['Track width', 'track_width'], ['Via diameter', 'via_diameter'],
				['Via drill', 'via_drill'], ['Microvia diameter', 'microvia_diameter'], ['Microvia drill', 'microvia_drill'],
				['Diff-pair width', 'diff_pair_width'], ['Diff-pair gap', 'diff_pair_gap'], ['Diff-pair via gap', 'diff_pair_via_gap']
			]],
			['Schematic (mil)', [
				['Wire width', 'wire_width', '1'], ['Bus width', 'bus_width', '1'], ['Line style', 'line_style', '1']
			]]
		];
		for (const [title, fields] of groups) {
			const heading = document.createElement('h3');
			heading.textContent = title;
			form.append(heading);
			for (const [label, key, step] of fields) addField(label, numberInput(netClass[key], value => { netClass[key] = value; this.changed(); }, step));
		}
		addField('PCB color', colorInput(String(netClass.pcb_color ?? ''), value => { netClass.pcb_color = value; this.changed(); }));
		addField('Schematic color', colorInput(String(netClass.schematic_color ?? ''), value => { netClass.schematic_color = value; this.changed(); }));
		addField('Tuning profile', textInput(String(netClass.tuning_profile ?? ''), value => { netClass.tuning_profile = value; this.changed(); }));
		if (netClass.name !== 'Default') form.append(button('Delete Net Class', 'danger', () => {
			if (!window.confirm(`Delete net class “${ netClass.name }”? Assignments to it must be changed before Apply.`)) return;
			this.draft?.removeNetClass(index);
			this.selectedNetClass = Math.max(0, index - 1);
			this.changed();
			this.renderPage();
		}));
		return form;
	}

	protected renderPatternTable(): void {
		const section = document.createElement('section');
		section.className = 'project-settings-section';
		const title = document.createElement('h3');
		title.textContent = 'Pattern Assignments';
		section.append(title, this.renderTwoColumnRows(
			this.draft!.netClassPatterns,
			['Pattern', 'Net class'],
			['pattern', 'netclass'],
			() => this.draft!.netClassPatterns.push({ pattern: '', netclass: 'Default' }),
			'Add Pattern'
		));
		this.contentEl.append(section);
	}

	protected renderAssignmentTable(): void {
		const section = document.createElement('section');
		section.className = 'project-settings-section';
		const title = document.createElement('h3');
		title.textContent = 'Direct Net Assignments';
		section.append(title, this.renderTwoColumnRows(
			this.assignmentRows,
			['Net name', 'Net class'],
			['net', 'netclass'],
			() => this.assignmentRows.push({ net: '', netclass: 'Default' }),
			'Add Assignment',
			() => this.commitAssignmentRows()
		));
		this.contentEl.append(section);
	}

	protected renderNetColorTable(): void {
		const section = document.createElement('section');
		section.className = 'project-settings-section';
		const title = document.createElement('h3');
		title.textContent = 'Net Colors';
		section.append(title, this.renderTwoColumnRows(
			this.netColorRows, ['Net name', 'KiCad color'], ['net', 'color'],
			() => this.netColorRows.push({ net: '', color: KICAD_COLOR_UNSET }),
			'Add Net Color', () => this.commitNetColors(), 'color'
		));
		this.contentEl.append(section);
	}

	protected commitNetColors(): void {
		if (!this.validateLocalRows().some(issue => issue.path === 'net_settings.net_colors')) {
			this.draft?.setNetColors(this.netColorRows);
		}
		this.updateChrome();
		this.renderIssues();
	}

	protected renderBusAliases(): void {
		this.pageHeading('Bus Alias Definitions', 'Named schematic bus groups stored in schematic.bus_aliases.');
		this.contentEl.append(this.renderTwoColumnRows(
			this.busAliasRows, ['Alias', 'Members (comma-separated)'], ['name', 'members'],
			() => this.busAliasRows.push({ name: `BUS_${ this.busAliasRows.length + 1 }`, members: '' }),
			'Add Bus Alias', () => this.commitBusAliases()
		));
		this.renderIssues();
	}

	protected commitBusAliases(): void {
		if (!this.validateLocalRows().some(issue => issue.path === 'schematic.bus_aliases')) {
			this.draft?.setBusAliases(this.busAliasRows.map(row => ({
				name: row.name,
				members: row.members.split(',').map(member => member.trim()).filter(Boolean)
			})));
		}
		this.updateChrome();
		this.renderIssues();
	}

	protected renderNetChains(): void {
		this.pageHeading('Net Chains', 'Assign KiCad net-chain patterns to a project net class.');
		this.contentEl.append(this.renderTwoColumnRows(
			this.netChainRows, ['Net chain', 'Net class'], ['chain', 'netclass'],
			() => this.netChainRows.push({ chain: '', netclass: 'Default' }),
			'Add Net Chain', () => this.commitNetChains()
		));
		this.renderIssues();
	}

	protected commitNetChains(): void {
		if (!this.validateLocalRows().some(issue => issue.path === 'net_settings.net_chain_classes')) {
			this.draft?.setNetChainClasses(this.netChainRows);
		}
		this.updateChrome();
		this.renderIssues();
	}

	protected renderLibraries(): void {
		this.pageHeading('Libraries', 'Project-pinned symbol and footprint libraries. Library table editing will be added with sidecar-file support.');
		const symbolSection = document.createElement('section');
		symbolSection.className = 'project-settings-section';
		const symbolTitle = document.createElement('h3');
		symbolTitle.textContent = 'Pinned Symbol Libraries';
		symbolSection.append(symbolTitle, this.renderStringRows(this.symbolLibraryRows, 'Library nickname', 'Add Symbol Library'));
		const footprintSection = document.createElement('section');
		footprintSection.className = 'project-settings-section';
		const footprintTitle = document.createElement('h3');
		footprintTitle.textContent = 'Pinned Footprint Libraries';
		footprintSection.append(footprintTitle, this.renderStringRows(this.footprintLibraryRows, 'Library nickname', 'Add Footprint Library'));
		this.contentEl.append(symbolSection, footprintSection);
		this.renderIssues();
	}

	protected renderStringRows(rows: string[], heading: string, addLabel: string): HTMLElement {
		const wrap = document.createElement('div');
		const table = document.createElement('table');
		table.className = 'project-settings-table';
		const head = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const value of [heading, '']) {
			const th = document.createElement('th');
			th.textContent = value;
			headRow.append(th);
		}
		head.append(headRow);
		const body = document.createElement('tbody');
		rows.forEach((value, index) => {
			const tr = document.createElement('tr');
			const valueCell = document.createElement('td');
			valueCell.append(textInput(value, next => { rows[index] = next; this.commitLibraries(); }));
			const actionCell = document.createElement('td');
			actionCell.append(button('Remove', 'danger-link', () => { rows.splice(index, 1); this.commitLibraries(); this.renderPage(); }));
			tr.append(valueCell, actionCell);
			body.append(tr);
		});
		table.append(head, body);
		wrap.append(table, button(addLabel, '', () => { rows.push(''); this.commitLibraries(); this.renderPage(); }));
		return wrap;
	}

	protected commitLibraries(): void {
		this.draft?.setPinnedLibraries(this.symbolLibraryRows, this.footprintLibraryRows);
		this.updateChrome();
		this.renderIssues();
	}

	protected renderComponentClasses(): void {
		const draft = this.draft!;
		this.pageHeading('Component Classes', 'Rule-facing component class assignments, matching KiCad’s current condition schema.');
		const sheetToggle = document.createElement('label');
		sheetToggle.className = 'project-settings-checkbox';
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = draft.sheetComponentClassesEnabled;
		checkbox.addEventListener('change', () => { draft.setSheetComponentClassesEnabled(checkbox.checked); this.changed(); });
		sheetToggle.append(checkbox, document.createTextNode(' Enable sheet-derived component classes'));
		this.contentEl.append(sheetToggle);

		draft.componentClassAssignments.forEach((assignment, index) => {
			this.contentEl.append(this.renderComponentAssignment(assignment, index));
		});
		this.contentEl.append(button('Add Component Class Assignment', '', () => {
			draft.addComponentClassAssignment();
			this.changed();
			this.renderPage();
		}));
		this.renderIssues();
	}

	protected renderComponentAssignment(assignment: ComponentClassAssignment, index: number): HTMLElement {
		const card = document.createElement('section');
		card.className = 'project-settings-card';
		const header = document.createElement('div');
		header.className = 'project-settings-card-header';
		const title = document.createElement('h3');
		title.textContent = assignment.component_class || `Assignment ${ index + 1 }`;
		header.append(title, button('Remove', 'danger-link', () => {
			this.draft!.componentClassAssignments.splice(index, 1);
			this.changed();
			this.renderPage();
		}));
		card.append(header);
		const form = document.createElement('div');
		form.className = 'project-settings-inline-form';
		const classLabel = document.createElement('label');
		classLabel.append(document.createTextNode('Component class'), textInput(assignment.component_class, value => {
			assignment.component_class = value;
			title.textContent = value || `Assignment ${ index + 1 }`;
			this.changed();
		}));
		const operatorLabel = document.createElement('label');
		operatorLabel.append(document.createTextNode('Match'));
		const operator = document.createElement('select');
		operator.append(new Option('All conditions', 'ALL'), new Option('Any condition', 'ANY'));
		operator.value = assignment.conditions_operator;
		operator.addEventListener('change', () => { assignment.conditions_operator = operator.value as 'ALL' | 'ANY'; this.changed(); });
		operatorLabel.append(operator);
		form.append(classLabel, operatorLabel);
		card.append(form);

		const conditions = Object.entries(assignment.conditions ?? {}).map(([key, data]) => ({
			type: key.replace(/-\d+$/, ''), primary: data.primary ?? '', secondary: data.secondary ?? '', data
		}));
		const table = document.createElement('table');
		table.className = 'project-settings-table';
		table.innerHTML = '<thead><tr><th>Condition</th><th>Primary</th><th>Secondary</th><th></th></tr></thead>';
		const body = document.createElement('tbody');
		const commit = (): void => {
			const next: ComponentClassAssignment['conditions'] = {};
			const counts = new Map<string, number>();
			for (const row of conditions) {
				const count = counts.get(row.type) ?? 0;
				counts.set(row.type, count + 1);
				const key = count === 0 ? row.type : `${ row.type }-${ count }`;
				next[key] = { ...row.data, primary: row.primary, secondary: row.secondary };
			}
			assignment.conditions = next;
			this.changed();
		};
		conditions.forEach((row, conditionIndex) => {
			const tr = document.createElement('tr');
			const typeCell = document.createElement('td');
			const typeSelect = document.createElement('select');
			for (const type of ['REFERENCE', 'FOOTPRINT', 'SIDE', 'ROTATION', 'FOOTPRINT_FIELD', 'CUSTOM', 'SHEET_NAME']) typeSelect.append(new Option(type.replaceAll('_', ' '), type));
			typeSelect.value = row.type;
			typeSelect.addEventListener('change', () => { row.type = typeSelect.value; commit(); });
			typeCell.append(typeSelect);
			const primaryCell = document.createElement('td');
			primaryCell.append(textInput(row.primary, value => { row.primary = value; commit(); }));
			const secondaryCell = document.createElement('td');
			secondaryCell.append(textInput(row.secondary, value => { row.secondary = value; commit(); }));
			const actionCell = document.createElement('td');
			actionCell.append(button('Remove', 'danger-link', () => { conditions.splice(conditionIndex, 1); commit(); this.renderPage(); }));
			tr.append(typeCell, primaryCell, secondaryCell, actionCell);
			body.append(tr);
		});
		table.append(body);
		card.append(table, button('Add Condition', '', () => {
			conditions.push({ type: 'REFERENCE', primary: '', secondary: '', data: {} });
			commit();
			this.renderPage();
		}));
		return card;
	}

	protected renderTuningProfiles(): void {
		const draft = this.draft!;
		this.pageHeading('Tuning Profiles', 'Impedance and time-domain profiles stored by current KiCad schema version 1.');
		draft.tuningProfiles.forEach((profile, index) => this.contentEl.append(this.renderTuningProfile(profile, index)));
		this.contentEl.append(button('Add Tuning Profile', '', () => { draft.addTuningProfile(); this.changed(); this.renderPage(); }));
		this.renderIssues();
	}

	protected renderTuningProfile(profile: TuningProfileRecord, index: number): HTMLElement {
		profile.layer_entries ??= [];
		profile.via_overrides ??= [];
		const card = document.createElement('section');
		card.className = 'project-settings-card';
		const header = document.createElement('div');
		header.className = 'project-settings-card-header';
		const title = document.createElement('h3');
		title.textContent = profile.profile_name || `Profile ${ index + 1 }`;
		header.append(title, button('Remove', 'danger-link', () => { this.draft!.tuningProfiles.splice(index, 1); this.changed(); this.renderPage(); }));
		card.append(header);
		const form = document.createElement('div');
		form.className = 'project-settings-inline-form project-settings-inline-form-wide';
		const add = (caption: string, control: HTMLElement): void => {
			const label = document.createElement('label');
			label.append(document.createTextNode(caption), control);
			form.append(label);
		};
		add('Name', textInput(profile.profile_name, value => { profile.profile_name = value; title.textContent = value || `Profile ${ index + 1 }`; this.changed(); }));
		const type = document.createElement('select');
		type.append(new Option('Single-ended', '0'), new Option('Differential', '1'));
		type.value = String(profile.type);
		type.addEventListener('change', () => { profile.type = Number(type.value); this.changed(); });
		add('Type', type);
		add('Target impedance (Ω)', numberInput(profile.target_impedance, value => { profile.target_impedance = value; this.changed(); }));
		add('Frequency (Hz)', numberInput(profile.frequency, value => { profile.frequency = value; this.changed(); }, '1000000'));
		add('Via propagation delay', numberInput(profile.via_prop_delay, value => { profile.via_prop_delay = value; this.changed(); }, '1'));
		for (const [caption, key] of [['Model solder mask', 'model_solder_mask'], ['Enable time-domain tuning', 'enable_time_domain_tuning']] as const) {
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = profile[key];
			checkbox.addEventListener('change', () => { profile[key] = checkbox.checked; this.changed(); });
			add(caption, checkbox);
		}
		card.append(form);
		card.append(this.renderProfileRecordTable(profile.layer_entries, [
			['Signal layer', 'signal_layer', 'text'], ['Top reference', 'top_reference_layer', 'text'],
			['Bottom reference', 'bottom_reference_layer', 'text'], ['Width', 'width', 'number'],
			['Diff-pair gap', 'diff_pair_gap', 'number'], ['Delay', 'delay', 'number']
		], 'Layer Propagation Entries', () => ({ signal_layer: 'F.Cu', top_reference_layer: '', bottom_reference_layer: '', width: 0, diff_pair_gap: 0, delay: 0 })));
		card.append(this.renderProfileRecordTable(profile.via_overrides, [
			['Signal from', 'signal_layer_from', 'text'], ['Signal to', 'signal_layer_to', 'text'],
			['Via from', 'via_layer_from', 'text'], ['Via to', 'via_layer_to', 'text'], ['Delay', 'delay', 'number']
		], 'Via Overrides', () => ({ signal_layer_from: 'F.Cu', signal_layer_to: 'B.Cu', via_layer_from: 'F.Cu', via_layer_to: 'B.Cu', delay: 0 })));
		return card;
	}

	protected renderProfileRecordTable(
		rows: Array<Record<string, unknown>>,
		fields: Array<[string, string, 'text' | 'number']>,
		titleText: string,
		createRow: () => Record<string, unknown>
	): HTMLElement {
		const section = document.createElement('div');
		section.className = 'project-settings-subtable';
		const title = document.createElement('h4');
		title.textContent = titleText;
		const table = document.createElement('table');
		table.className = 'project-settings-table';
		const head = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const caption of [...fields.map(field => field[0]), '']) {
			const th = document.createElement('th');
			th.textContent = caption;
			headRow.append(th);
		}
		head.append(headRow);
		const body = document.createElement('tbody');
		rows.forEach((row, index) => {
			const tr = document.createElement('tr');
			for (const [, key, kind] of fields) {
				const td = document.createElement('td');
				td.append(kind === 'number'
					? numberInput(row[key], value => { row[key] = value; this.changed(); })
					: textInput(String(row[key] ?? ''), value => { row[key] = value; this.changed(); }));
				tr.append(td);
			}
			const td = document.createElement('td');
			td.append(button('Remove', 'danger-link', () => { rows.splice(index, 1); this.changed(); this.renderPage(); }));
			tr.append(td);
			body.append(tr);
		});
		table.append(head, body);
		section.append(title, table, button('Add Row', '', () => { rows.push(createRow()); this.changed(); this.renderPage(); }));
		return section;
	}

	protected renderTwoColumnRows<T extends Record<string, any>>(
		rows: T[], headings: [string, string], keys: [keyof T, keyof T], add: () => void, addLabel: string,
		onChange: () => void = () => this.changed(), colorColumn?: keyof T
	): HTMLElement {
		const wrap = document.createElement('div');
		const table = document.createElement('table');
		table.className = 'project-settings-table';
		const head = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const value of [...headings, '']) {
			const th = document.createElement('th');
			th.textContent = value;
			headRow.append(th);
		}
		head.append(headRow);
		const body = document.createElement('tbody');
		rows.forEach((row, index) => {
			const tr = document.createElement('tr');
			for (const key of keys) {
				const td = document.createElement('td');
				if (key === colorColumn) {
					td.append(colorInput(String(row[key] ?? ''), value => { row[key] = value as T[keyof T]; onChange(); }));
				} else {
					td.append(textInput(String(row[key] ?? ''), value => { row[key] = value as T[keyof T]; onChange(); }));
				}
				tr.append(td);
			}
			const td = document.createElement('td');
			td.append(button('Remove', 'danger-link', () => { rows.splice(index, 1); onChange(); this.renderPage(); }));
			tr.append(td);
			body.append(tr);
		});
		table.append(head, body);
		wrap.append(table, button(addLabel, '', () => { add(); onChange(); this.renderPage(); }));
		return wrap;
	}

	protected commitAssignmentRows(): void {
		if (!this.validateLocalRows().some(issue => issue.path === 'net_settings.netclass_assignments')) {
			this.draft?.setNetClassAssignments(this.assignmentRows);
		}
		this.updateChrome();
		this.renderIssues();
	}

	protected settingsGroup(titleText: string): HTMLElement {
		const section = document.createElement('section');
		section.className = 'project-settings-section project-settings-form-section';
		const title = document.createElement('h3');
		title.textContent = titleText;
		section.append(title);
		return section;
	}

	protected settingRow(labelText: string, control: HTMLElement, help = ''): HTMLLabelElement {
		const label = document.createElement('label');
		label.className = 'project-setting-row';
		const caption = document.createElement('span');
		caption.textContent = labelText;
		label.append(caption, control);
		if (help) {
			const hint = document.createElement('small');
			hint.textContent = help;
			label.append(hint);
		}
		return label;
	}

	protected renderSchematicFormatting(): void {
		const draft = this.draft!;
		const drawing = draft.schematicDrawing;
		const drawingNumber = (key: string, fallback: number): number => typeof drawing[key] === 'number' ? drawing[key] as number : fallback;
		const drawingString = (key: string, fallback: string): string => typeof drawing[key] === 'string' ? drawing[key] as string : fallback;
		const drawingBool = (key: string, fallback: boolean): boolean => typeof drawing[key] === 'boolean' ? drawing[key] as boolean : fallback;
		const setDrawing = (key: string, value: unknown): void => { draft.setSchematicDrawingValue(key, value); this.changed(); };
		this.pageHeading('Formatting', 'KiCad schematic drawing defaults stored in the project file. Distances are serialized in mils.');

		const defaults = this.settingsGroup('Drawing Defaults');
		for (const [label, key, fallback, step] of [
			['Default text size (mil)', 'default_text_size', 50, '1'],
			['Default line thickness (mil)', 'default_line_thickness', 6, '1'],
			['Pin symbol size (mil)', 'pin_symbol_size', 25, '1'],
			['Connection grid size (mil)', 'connection_grid_size', 50, '1']
		] as const) {
			const value = key === 'connection_grid_size'
				? Number(draft.getSchematicValue(key, fallback)) : drawingNumber(key, fallback);
			defaults.append(this.settingRow(label, numberInput(value, next => {
				if (key === 'connection_grid_size') draft.setSchematicValue(key, next);
				else draft.setSchematicDrawingValue(key, next);
				this.changed();
			}, step)));
		}
		defaults.append(
			this.settingRow('Junction dot size', selectInput(drawingNumber('junction_size_choice', 3), [
				['None', 0], ['Smallest', 1], ['Small', 2], ['Default', 3], ['Large', 4], ['Largest', 5]
			], value => setDrawing('junction_size_choice', Number(value)))),
			this.settingRow('Wire hop-over size', selectInput(drawingNumber('hop_over_size_choice', 0), [
				['None', 0], ['Smallest', 1], ['Small', 2], ['Default', 3], ['Large', 4], ['Largest', 5]
			], value => setDrawing('hop_over_size_choice', Number(value))))
		);

		const typography = this.settingsGroup('Typography and Line Style');
		for (const [label, key, fallback] of [
			['Text offset (%)', 'text_offset_ratio', 0.15],
			['Label size ratio (%)', 'label_size_ratio', 0.375],
			['Overbar offset (%)', 'overbar_offset_ratio', 1.23]
		] as const) {
			typography.append(this.settingRow(label, numberInput(drawingNumber(key, fallback) * 100, value => setDrawing(key, value / 100), '1')));
		}
		typography.append(
			this.settingRow('Dashed line dash ratio', numberInput(drawingNumber('dashed_lines_dash_length_ratio', 12), value => setDrawing('dashed_lines_dash_length_ratio', value))),
			this.settingRow('Dashed line gap ratio', numberInput(drawingNumber('dashed_lines_gap_length_ratio', 3), value => setDrawing('dashed_lines_gap_length_ratio', value)))
		);

		const intersheet = this.settingsGroup('Intersheet References');
		intersheet.append(checkboxInput(drawingBool('intersheets_ref_show', false), 'Show intersheet references', value => setDrawing('intersheets_ref_show', value)));
		intersheet.append(
			this.settingRow('Format', selectInput(drawingBool('intersheets_ref_short', false) ? 1 : 0, [
				['Standard', 0], ['Abbreviated', 1]
			], value => setDrawing('intersheets_ref_short', value === '1'))),
			this.settingRow('Prefix', textInput(drawingString('intersheets_ref_prefix', ''), value => setDrawing('intersheets_ref_prefix', value))),
			this.settingRow('Suffix', textInput(drawingString('intersheets_ref_suffix', ''), value => setDrawing('intersheets_ref_suffix', value))),
			checkboxInput(drawingBool('intersheets_ref_own_page', true), 'Include the current page in the reference list', value => setDrawing('intersheets_ref_own_page', value))
		);

		const simulation = this.settingsGroup('Operating Point Overlay');
		simulation.append(
			this.settingRow('Voltage precision', numberInput(drawingNumber('operating_point_overlay_v_precision', 3), value => setDrawing('operating_point_overlay_v_precision', value), '1')),
			this.settingRow('Voltage range', textInput(drawingString('operating_point_overlay_v_range', '~V'), value => setDrawing('operating_point_overlay_v_range', value)), 'Use ~V for automatic range.'),
			this.settingRow('Current precision', numberInput(drawingNumber('operating_point_overlay_i_precision', 3), value => setDrawing('operating_point_overlay_i_precision', value), '1')),
			this.settingRow('Current range', textInput(drawingString('operating_point_overlay_i_range', '~A'), value => setDrawing('operating_point_overlay_i_range', value)), 'Use ~A for automatic range.')
		);

		const files = this.settingsGroup('Output Paths');
		files.append(
			this.settingRow('Drawing sheet file', textInput(String(draft.getSchematicValue('page_layout_descr_file', '')), value => { draft.setSchematicValue('page_layout_descr_file', value); this.changed(); })),
			this.settingRow('Plot directory', textInput(String(draft.getSchematicValue('plot_directory', '')), value => { draft.setSchematicValue('plot_directory', value); this.changed(); }))
		);
		this.contentEl.append(defaults, typography, intersheet, simulation, files);
		this.renderIssues();
	}

	protected renderSchematicAnnotation(): void {
		const draft = this.draft!;
		const annotation = draft.annotation;
		const setAnnotation = (key: string, value: unknown): void => { draft.setAnnotationValue(key, value); this.changed(); };
		this.pageHeading('Annotation', 'Symbol unit notation, ordering, numbering, and reference reuse from KiCad Schematic Setup.');
		const units = this.settingsGroup('Units');
		units.append(
			this.settingRow('Symbol unit notation', selectInput(Number(draft.getSchematicValue('subpart_id_separator', 0)), [
				['A (no separator)', 0], ['.A', 46], ['-A', 45], ['_A', 95]
			], value => { draft.setSchematicValue('subpart_id_separator', Number(value)); this.changed(); })),
			this.settingRow('First unit identifier', selectInput(Number(draft.getSchematicValue('subpart_first_id', 65)), [
				['A, B, C…', 65], ['a, b, c…', 97], ['1, 2, 3…', 49]
			], value => { draft.setSchematicValue('subpart_first_id', Number(value)); this.changed(); }))
		);
		const order = this.settingsGroup('Order');
		order.append(this.settingRow('Sort symbols by', selectInput(Number(annotation.sort_order ?? 0), [
			['X position', 0], ['Y position', 1]
		], value => setAnnotation('sort_order', Number(value)))));
		const numbering = this.settingsGroup('Numbering');
		numbering.append(
			this.settingRow('Numbering method', selectInput(Number(annotation.method ?? 0), [
				['Use first free number', 0], ['First free after sheet number × 100', 1], ['First free after sheet number × 1000', 2]
			], value => setAnnotation('method', Number(value)))),
			this.settingRow('Use first free number after', numberInput(Number(draft.getSchematicValue('annotate_start_num', 0)), value => { draft.setSchematicValue('annotate_start_num', value); this.changed(); }, '1')),
			checkboxInput(Boolean(draft.getSchematicValue('reuse_designators', false)), 'Allow reference reuse', value => { draft.setSchematicValue('reuse_designators', value); this.changed(); })
		);
		this.contentEl.append(units, order, numbering);
		this.renderIssues();
	}

	protected renderFieldNameTemplates(): void {
		const draft = this.draft!;
		this.pageHeading('Field Name Templates', 'Project-specific fields offered when creating or editing symbols.');
		const table = document.createElement('table');
		table.className = 'project-settings-table';
		table.innerHTML = '<thead><tr><th>Field name</th><th>Visible</th><th>URL</th><th>Order</th><th></th></tr></thead>';
		const body = document.createElement('tbody');
		const rows = draft.fieldNameTemplates;
		rows.forEach((field: FieldNameTemplateRecord, index) => {
			const tr = document.createElement('tr');
			const name = document.createElement('td');
			name.append(textInput(String(field.name ?? ''), value => { field.name = value; this.changed(); }));
			const visible = document.createElement('td');
			visible.append(checkboxInput(Boolean(field.visible), '', value => { field.visible = value; this.changed(); }));
			const url = document.createElement('td');
			url.append(checkboxInput(Boolean(field.url), '', value => { field.url = value; this.changed(); }));
			const order = document.createElement('td');
			order.className = 'project-settings-inline-actions';
			order.append(
				button('↑', '', () => { if (index > 0) [rows[index - 1], rows[index]] = [rows[index]!, rows[index - 1]!]; this.changed(); this.renderPage(); }),
				button('↓', '', () => { if (index < rows.length - 1) [rows[index], rows[index + 1]] = [rows[index + 1]!, rows[index]!]; this.changed(); this.renderPage(); })
			);
			const action = document.createElement('td');
			action.append(button('Remove', 'danger-link', () => { rows.splice(index, 1); this.changed(); this.renderPage(); }));
			tr.append(name, visible, url, order, action);
			body.append(tr);
		});
		table.append(body);
		this.contentEl.append(table, button('Add Field Template', '', () => { draft.addFieldNameTemplate(); this.changed(); this.renderPage(); }));
		this.renderIssues();
	}

	protected renderBomPresets(): void {
		const draft = this.draft!;
		this.pageHeading('BOM Presets', 'Editing, grouping, filtering, field ordering, and text export formats used by KiCad BOM generation.');
		const current = draft.bomSettings;
		const currentFormat = draft.bomFormatSettings;
		const changeCurrent = (): void => { if (!draft.hasBomSettings) draft.setBomSettings(current); this.changed(); };
		const changeCurrentFormat = (): void => { if (!draft.hasBomFormatSettings) draft.setBomFormatSettings(currentFormat); this.changed(); };
		this.contentEl.append(this.renderBomPresetCard(current, 'Current BOM View', undefined, changeCurrent));
		const presets = this.settingsGroup('Saved BOM Views');
		for (let index = 0; index < draft.bomPresets.length; index++) {
			presets.append(this.renderBomPresetCard(draft.bomPresets[index]!, `Preset ${ index + 1 }`, () => {
				draft.bomPresets.splice(index, 1); this.changed(); this.renderPage();
			}));
		}
		presets.append(button('Add BOM View Preset', '', () => {
			draft.bomPresets.push(structuredClone({ ...current, name: `Preset ${ draft.bomPresets.length + 1 }` }));
			this.changed(); this.renderPage();
		}));
		this.contentEl.append(presets, this.renderBomFormatCard(currentFormat, 'Current Export Format', undefined, changeCurrentFormat));
		const formats = this.settingsGroup('Saved Export Formats');
		for (let index = 0; index < draft.bomFormatPresets.length; index++) {
			formats.append(this.renderBomFormatCard(draft.bomFormatPresets[index]!, `Format ${ index + 1 }`, () => {
				draft.bomFormatPresets.splice(index, 1); this.changed(); this.renderPage();
			}));
		}
		formats.append(button('Add Export Format', '', () => {
			draft.bomFormatPresets.push(structuredClone({ ...currentFormat, name: `Format ${ draft.bomFormatPresets.length + 1 }` }));
			this.changed(); this.renderPage();
		}));
		const output = this.settingsGroup('Output');
		output.append(this.settingRow('BOM export filename', textInput(String(draft.getSchematicValue('bom_export_filename', '${PROJECTNAME}.csv')), value => {
			draft.setSchematicValue('bom_export_filename', value); this.changed();
		})));
		this.contentEl.append(formats, output);
		this.renderIssues();
	}

	protected renderBomPresetCard(
		preset: BomPresetRecord,
		titleText: string,
		remove?: () => void,
		onMutate: () => void = () => this.changed()
	): HTMLElement {
		if (!Array.isArray(preset.fields_ordered)) preset.fields_ordered = [];
		const card = document.createElement('section');
		card.className = 'project-settings-card';
		const header = document.createElement('div');
		header.className = 'project-settings-card-header';
		const title = document.createElement('h3');
		title.textContent = titleText;
		header.append(title);
		if (remove) header.append(button('Remove', 'danger-link', remove));
		const form = document.createElement('div');
		form.className = 'project-settings-form-grid';
		form.append(
			this.settingRow('Name', textInput(String(preset.name ?? ''), value => { preset.name = value; onMutate(); })),
			this.settingRow('Sort field', textInput(String(preset.sort_field ?? ''), value => { preset.sort_field = value; onMutate(); })),
			this.settingRow('Sort order', selectInput(preset.sort_asc === false ? 'desc' : 'asc', [['Ascending', 'asc'], ['Descending', 'desc']], value => { preset.sort_asc = value === 'asc'; onMutate(); })),
			this.settingRow('Filter', textInput(String(preset.filter_string ?? ''), value => { preset.filter_string = value; onMutate(); }))
		);
		const checks = document.createElement('div');
		checks.className = 'project-settings-check-row';
		checks.append(
			checkboxInput(Boolean(preset.group_symbols), 'Group symbols', value => { preset.group_symbols = value; onMutate(); }),
			checkboxInput(Boolean(preset.exclude_dnp), 'Exclude DNP', value => { preset.exclude_dnp = value; onMutate(); }),
			checkboxInput(Boolean(preset.include_excluded_from_bom), 'Include symbols excluded from BOM', value => { preset.include_excluded_from_bom = value; onMutate(); })
		);
		const fields = document.createElement('table');
		fields.className = 'project-settings-table';
		fields.innerHTML = '<thead><tr><th>Field</th><th>Column label</th><th>Show</th><th>Group by</th><th></th></tr></thead>';
		const body = document.createElement('tbody');
		preset.fields_ordered.forEach((field: BomFieldRecord, index) => {
			const tr = document.createElement('tr');
			for (const [value, commit] of [
				[String(field.name ?? ''), (next: string) => { field.name = next; }],
				[String(field.label ?? ''), (next: string) => { field.label = next; }]
			] as const) {
				const td = document.createElement('td'); td.append(textInput(value, next => { commit(next); onMutate(); })); tr.append(td);
			}
			for (const [checked, commit] of [
				[Boolean(field.show), (value: boolean) => { field.show = value; }],
				[Boolean(field.group_by), (value: boolean) => { field.group_by = value; }]
			] as const) {
				const td = document.createElement('td'); td.append(checkboxInput(checked, '', value => { commit(value); onMutate(); })); tr.append(td);
			}
			const action = document.createElement('td');
			action.append(button('Remove', 'danger-link', () => { preset.fields_ordered.splice(index, 1); onMutate(); this.renderPage(); }));
			tr.append(action); body.append(tr);
		});
		fields.append(body);
		card.append(header, form, checks, fields, button('Add BOM Field', '', () => {
			preset.fields_ordered.push({ name: '', label: '', show: true, group_by: false }); onMutate(); this.renderPage();
		}));
		return card;
	}

	protected renderBomFormatCard(
		preset: BomFormatPresetRecord,
		titleText: string,
		remove?: () => void,
		onMutate: () => void = () => this.changed()
	): HTMLElement {
		const card = document.createElement('section');
		card.className = 'project-settings-card';
		const header = document.createElement('div'); header.className = 'project-settings-card-header';
		const title = document.createElement('h3'); title.textContent = titleText; header.append(title);
		if (remove) header.append(button('Remove', 'danger-link', remove));
		const form = document.createElement('div'); form.className = 'project-settings-form-grid';
		for (const [label, key] of [
			['Name', 'name'], ['Field delimiter', 'field_delimiter'], ['String delimiter', 'string_delimiter'],
			['Reference delimiter', 'ref_delimiter'], ['Reference range delimiter', 'ref_range_delimiter']
		] as const) {
			form.append(this.settingRow(label, textInput(String(preset[key] ?? ''), value => { preset[key] = value; onMutate(); })));
		}
		const checks = document.createElement('div'); checks.className = 'project-settings-check-row';
		checks.append(
			checkboxInput(Boolean(preset.keep_tabs), 'Keep tabs', value => { preset.keep_tabs = value; onMutate(); }),
			checkboxInput(Boolean(preset.keep_line_breaks), 'Keep line breaks', value => { preset.keep_line_breaks = value; onMutate(); })
		);
		card.append(header, form, checks);
		return card;
	}

	protected renderErcSeverity(): void {
		const severities = this.draft!.ercRuleSeverities;
		this.pageHeading('Violation Severity', 'Every ERC rule registered in the project, including keys added by newer KiCad versions.');
		const table = document.createElement('table');
		table.className = 'project-settings-table erc-severity-table';
		table.innerHTML = '<thead><tr><th>Violation</th><th>Settings key</th><th>Severity</th></tr></thead>';
		const body = document.createElement('tbody');
		for (const key of Object.keys(severities).sort((a, b) => a.localeCompare(b))) {
			const tr = document.createElement('tr');
			const label = document.createElement('td'); label.textContent = key.replaceAll('_', ' ').replace(/\b\w/g, value => value.toUpperCase());
			const raw = document.createElement('td'); raw.textContent = key; raw.className = 'project-settings-mono';
			const choice = document.createElement('td');
			const current = severities[key]!;
			const options: Array<readonly [string, string]> = [['Ignore', 'ignore'], ['Warning', 'warning'], ['Error', 'error']];
			if (!options.some(([, value]) => value === current)) options.unshift([`Preserve unknown value (${ current })`, current]);
			choice.append(selectInput(current, options, value => {
				this.draft!.setErcRuleSeverity(key, value); this.changed();
			}));
			tr.append(label, raw, choice); body.append(tr);
		}
		table.append(body); this.contentEl.append(table); this.renderIssues();
	}

	protected renderPinConflicts(): void {
		const labels = ['Input', 'Output', 'Bidirectional', 'Tri-state', 'Passive', 'Free', 'Unspecified', 'Power input', 'Power output', 'Open collector', 'Open emitter', 'No connect'];
		const short = ['I', 'O', 'Bi', '3S', 'Pas', 'Free', 'UnS', 'PwrI', 'PwrO', 'OC', 'OE', 'NC'];
		const stateLabels = ['No error or warning', 'Generate warning', 'Generate error'];
		const matrix = this.draft!.pinMap;
		this.pageHeading('Pin Conflicts Map', 'Click a cell to cycle through KiCad’s OK, warning, and error states. Mirrored cells are updated together.');
		const wrap = document.createElement('div'); wrap.className = 'pin-map-scroll';
		const table = document.createElement('table'); table.className = 'pin-map-table';
		const head = document.createElement('thead'); const headRow = document.createElement('tr'); headRow.append(document.createElement('th'));
		for (let column = 0; column < labels.length; column++) {
			const th = document.createElement('th'); th.textContent = short[column]!; th.title = labels[column]!; headRow.append(th);
		}
		head.append(headRow); const body = document.createElement('tbody');
		for (let row = 0; row < labels.length; row++) {
			const tr = document.createElement('tr'); const th = document.createElement('th'); th.textContent = labels[row]!; tr.append(th);
			for (let column = 0; column < labels.length; column++) {
				const td = document.createElement('td');
				if (column <= row) {
					const value = matrix[row]?.[column] ?? 0;
					const cell = button(value === 0 ? '●' : value === 1 ? '▲' : '×', `pin-map-state state-${ value }`, () => {
						this.draft!.setPinMapValue(row, column, (value + 1) % 3); this.changed(); this.renderPage();
					});
					cell.title = `${ labels[row] } + ${ labels[column] }: ${ stateLabels[value] }`;
					cell.setAttribute('aria-label', cell.title); td.append(cell);
				}
				tr.append(td);
			}
			body.append(tr);
		}
		table.append(head, body); wrap.append(table);
		const legend = document.createElement('div'); legend.className = 'pin-map-legend';
		legend.innerHTML = '<span class="state-0">● No error</span><span class="state-1">▲ Warning</span><span class="state-2">× Error</span>';
		this.contentEl.append(wrap, legend, button('Reset to KiCad Defaults', '', () => { this.draft!.resetPinMap(); this.changed(); this.renderPage(); }));
		this.renderIssues();
	}

	protected renderBoardLayers(): void {
		const draft = this.draft!;
		this.pageHeading('Board Editor Layers', 'Enabled KiCad board layers, canonical IDs, user names, and copper electrical types. Layer IDs and canonical names remain fixed for file compatibility.');
		if (!draft.hasBoard) { this.renderMissingBoardNotice(); return; }
		const controls = this.settingsGroup('Copper Layers');
		const counts = Array.from({ length: 16 }, (_, index) => (index + 1) * 2);
		controls.append(this.settingRow('Copper layer count', selectInput(draft.copperLayerCount, counts.map(value => [`${ value } layers`, value] as const), value => {
			try { draft.setCopperLayerCount(Number(value)); this.changed(); }
			catch (error) { this.deps.setStatus(error instanceof Error ? error.message : String(error)); }
			this.renderPage();
		})));
		const hint = document.createElement('p');
		hint.className = 'project-settings-help';
		hint.textContent = 'Reducing the layer count is blocked while board items still reference a layer. Stackup copper and dielectric rows are synchronized automatically.';
		controls.append(hint);
		this.contentEl.append(controls);

		const table = document.createElement('table'); table.className = 'project-settings-table board-layer-table';
		table.innerHTML = '<thead><tr><th>ID</th><th>KiCad layer</th><th>User name / alias</th><th>Type</th></tr></thead>';
		const body = document.createElement('tbody');
		draft.boardLayers.forEach((layer, index) => {
			const tr = document.createElement('tr');
			const id = document.createElement('td'); id.textContent = String(layer.id); id.className = 'project-settings-mono';
			const name = document.createElement('td'); name.textContent = layer.name;
			const alias = document.createElement('td'); alias.append(textInput(layer.alias ?? '', value => { draft.setBoardLayerAlias(index, value); this.changed(); }));
			const type = document.createElement('td');
			const copper = layer.id === 0 || layer.id === 2 || (layer.id >= 4 && layer.id <= 62 && layer.id % 2 === 0);
			const options: Array<readonly [string, KicadLayerType]> = copper
				? [['Signal', 'signal'], ['Power plane', 'power'], ['Mixed', 'mixed'], ['Jumper', 'jumper']]
				: [[layer.type === 'front' ? 'Front' : layer.type === 'back' ? 'Back' : 'User', layer.type]];
			const typeSelect = selectInput(layer.type, options, value => { draft.setBoardLayerType(index, value as KicadLayerType); this.changed(); });
			typeSelect.disabled = !copper;
			type.append(typeSelect);
			tr.append(id, name, alias, type); body.append(tr);
		});
		table.append(body); this.contentEl.append(table); this.renderIssues();
	}

	protected renderPhysicalStackup(): void {
		const draft = this.draft!;
		this.pageHeading('Physical Stackup', 'KiCad board stackup layers and material properties stored directly in the .kicad_pcb setup block. Dielectric rows can be locked, added, and removed; copper rows can only be added/removed from Board Editor Layers.');
		if (!draft.hasBoard) { this.renderMissingBoardNotice(); return; }
		const summary = this.settingsGroup('Board Thickness');
		const total = draft.stackupThickness;
		const calculated = document.createElement('span'); calculated.textContent = `${ total.toFixed(4) } mm`;
		summary.append(
			this.settingRow('Declared board thickness (mm)', numberInput(draft.boardThickness, value => { draft.setBoardThickness(value); this.changed(); }, '0.0001')),
			this.settingRow('Calculated stackup thickness', calculated)
		);
		summary.append(button('Use Calculated Thickness', '', () => { draft.setBoardThickness(draft.stackupThickness); this.changed(); this.renderPage(); }));
		if (Math.abs(draft.boardThickness - total) > 0.0001) {
			const warning = document.createElement('p'); warning.className = 'project-settings-help warning';
			warning.textContent = `The declared thickness differs from the stackup by ${ Math.abs(draft.boardThickness - total).toFixed(4) } mm.`;
			summary.append(warning);
		}
		this.contentEl.append(summary);

		const table = document.createElement('table'); table.className = 'project-settings-table stackup-table';
		table.innerHTML = '<thead><tr><th>Layer</th><th>Type</th><th>Thickness (mm)</th><th>Locked</th><th>Material</th><th>Color</th><th>εr</th><th>Loss tan</th><th></th></tr></thead>';
		const body = document.createElement('tbody');
		const stackupLayers = draft.stackupLayers;
		for (const row of stackupLayers) {
			const tr = document.createElement('tr');
			const name = document.createElement('td'); name.textContent = row.name; name.className = 'project-settings-mono';
			const dielectric = /^dielectric\s+/i.test(row.name);
			const type = document.createElement('td');
			const typeOptions: Array<readonly [string, string]> = dielectric
				? [['Prepreg', 'prepreg'], ['Core', 'core']]
				: [[row.type || 'Not specified', row.type || ''], ['Copper', 'copper'], ['Top solder mask', 'Top Solder Mask'], ['Bottom solder mask', 'Bottom Solder Mask'], ['Top solder paste', 'Top Solder Paste'], ['Bottom solder paste', 'Bottom Solder Paste'], ['Top silkscreen', 'Top Silk Screen'], ['Bottom silkscreen', 'Bottom Silk Screen']];
			const typeSelect = selectInput(row.type, typeOptions.filter((item, index, all) => all.findIndex(other => other[1] === item[1]) === index), value => { draft.updateStackupLayer(row.index, { type: value }); this.changed(); });
			typeSelect.disabled = !dielectric;
			type.append(typeSelect);
			const thickness = document.createElement('td'); thickness.append(numberInput(row.thickness ?? 0, value => { draft.updateStackupLayer(row.index, { thickness: value }); this.changed(); }, '0.0001'));
			const locked = document.createElement('td');
			const lockedCheckbox = document.createElement('input'); lockedCheckbox.type = 'checkbox'; lockedCheckbox.checked = Boolean(row.lockThickness);
			lockedCheckbox.addEventListener('change', () => { draft.updateStackupLayer(row.index, { lockThickness: lockedCheckbox.checked }); this.changed(); });
			locked.append(lockedCheckbox);
			const kind = stackupRowKind(row);
			const material = document.createElement('td');
			const color = document.createElement('td');
			if (kind === 'dielectric' || kind === 'soldermask' || kind === 'silkscreen') {
				const baseMaterials = kind === 'dielectric' ? DIELECTRIC_MATERIALS : kind === 'soldermask' ? SOLDERMASK_MATERIALS : SILKSCREEN_MATERIALS;
				const isSpecified = row.material && row.material.toLowerCase() !== 'not specified';
				const materialInput = document.createElement('input');
				materialInput.type = 'text';
				materialInput.value = isSpecified ? row.material! : 'Not specified';
				materialInput.addEventListener('input', () => { draft.updateStackupLayer(row.index, { material: materialInput.value }); this.changed(); });
				const materialButton = button('…', 'material-dialog-trigger', () => {
					openMaterialDialog(
						materialsInUse(stackupLayers, kind, baseMaterials),
						{ name: isSpecified ? row.material! : baseMaterials[0]![0], epsilonR: row.epsilonR ?? 0, lossTangent: row.lossTangent ?? 0 },
						result => {
							draft.updateStackupLayer(row.index, { material: result.name, epsilonR: result.epsilonR, lossTangent: result.lossTangent });
							this.changed();
							this.renderPage();
						}
					);
				});
				const materialGroup = document.createElement('div');
				materialGroup.className = 'material-input-group';
				materialGroup.append(materialInput, materialButton);
				material.append(materialGroup);

				const predefined = kind === 'dielectric' ? DIELECTRIC_COLORS : GBRJOB_COLORS;
				color.append(stackupColorCell(row.color, predefined, value => { draft.updateStackupLayer(row.index, { color: value }); this.changed(); }));
			} else {
				material.textContent = '—';
				color.textContent = '—';
			}
			const epsilon = document.createElement('td'); epsilon.append(numberInput(row.epsilonR ?? 0, value => { draft.updateStackupLayer(row.index, { epsilonR: value }); this.changed(); }, '0.01'));
			const loss = document.createElement('td'); loss.append(numberInput(row.lossTangent ?? 0, value => { draft.updateStackupLayer(row.index, { lossTangent: value }); this.changed(); }, '0.001'));
			const action = document.createElement('td'); action.className = 'stackup-row-actions';
			action.append(button('Insert Dielectric Below', '', () => { draft.insertDielectricLayer(row.index); this.changed(); this.renderPage(); }));
			if (dielectric) action.append(button('Remove', 'danger-link', () => { draft.removeDielectricLayer(row.index); this.changed(); this.renderPage(); }));
			tr.append(name, type, thickness, locked, material, color, epsilon, loss, action); body.append(tr);
		}
		table.append(body); this.contentEl.append(table);
		this.contentEl.append(button('Add Dielectric', '', () => { draft.insertDielectricLayer(draft.stackupLayers.length - 2); this.changed(); this.renderPage(); }));
		this.renderIssues();
	}

	protected renderBoardFinish(): void {
		const draft = this.draft!;
		this.pageHeading('Board Finish', 'Fabrication finish and edge options serialized in KiCad’s physical stackup.');
		if (!draft.hasBoard) { this.renderMissingBoardNotice(); return; }
		const finish = this.settingsGroup('Fabrication');
		const currentFinish = String(draft.getBoardFinishValue('copper_finish', 'None'));
		const finishes = ['None', 'ENIG', 'ENEPIG', 'HASL', 'Lead-free HASL', 'Hard gold', 'OSP', 'Immersion silver', 'Immersion tin'];
		if (!finishes.includes(currentFinish)) finishes.unshift(currentFinish);
		finish.append(
			this.settingRow('Copper finish', selectInput(currentFinish, finishes.map(value => [value, value] as const), value => { draft.setBoardFinishValue('copper_finish', value); this.changed(); })),
			checkboxInput(Boolean(draft.getBoardFinishValue('dielectric_constraints', false)), 'Impedance controlled', value => { draft.setBoardFinishValue('dielectric_constraints', value); this.changed(); }),
			this.settingRow('Edge connector', selectInput(String(draft.getBoardFinishValue('edge_connector', 'none')), [['None', 'none'], ['Yes', 'yes'], ['Bevelled', 'bevelled']], value => { draft.setBoardFinishValue('edge_connector', value); this.changed(); })),
			checkboxInput(Boolean(draft.getBoardFinishValue('edge_plating', false)), 'Plated board edges', value => { draft.setBoardFinishValue('edge_plating', value); this.changed(); })
		);
		this.contentEl.append(finish); this.renderIssues();
	}

	protected renderMaskPaste(): void {
		const draft = this.draft!;
		this.pageHeading('Solder Mask / Paste', 'Global mask, paste, and via-protection settings from KiCad’s board setup. Negative paste values shrink apertures.');
		if (!draft.hasBoard) { this.renderMissingBoardNotice(); return; }
		const mask = this.settingsGroup('Solder Mask');
		mask.append(
			this.settingRow('Solder mask expansion (mm)', numberInput(draft.getBoardSetupNumber('pad_to_mask_clearance'), value => { draft.setBoardSetupNumber('pad_to_mask_clearance', value); this.changed(); }, '0.001', null)),
			this.settingRow('Minimum mask web width (mm)', numberInput(draft.getBoardSetupNumber('solder_mask_min_width'), value => { draft.setBoardSetupNumber('solder_mask_min_width', value); this.changed(); }, '0.001')),
			checkboxInput(draft.getBoardSetupBoolean('allow_soldermask_bridges_in_footprints'), 'Allow solder mask bridges in footprints', value => { draft.setBoardSetupBoolean('allow_soldermask_bridges_in_footprints', value); this.changed(); })
		);
		const paste = this.settingsGroup('Solder Paste');
		paste.append(
			this.settingRow('Absolute clearance (mm)', numberInput(draft.getBoardSetupNumber('pad_to_paste_clearance'), value => { draft.setBoardSetupNumber('pad_to_paste_clearance', value); this.changed(); }, '0.001', null)),
			this.settingRow('Relative clearance (ratio)', numberInput(draft.getBoardSetupNumber('pad_to_paste_clearance_ratio'), value => { draft.setBoardSetupNumber('pad_to_paste_clearance_ratio', value); this.changed(); }, '0.01', null))
		);
		const via = this.settingsGroup('Via Protection');
		for (const [key, label] of [['tenting', 'Tent vias'], ['covering', 'Cover vias'], ['plugging', 'Plug vias']] as const) {
			const sides = draft.getBoardSetupSides(key);
			const row = document.createElement('div'); row.className = 'project-settings-check-row';
			const commit = (): void => { draft.setBoardSetupSides(key, sides.front, sides.back); this.changed(); };
			row.append(
				checkboxInput(sides.front, `${ label } — front`, value => { sides.front = value; commit(); }),
				checkboxInput(sides.back, `${ label } — back`, value => { sides.back = value; commit(); })
			);
			via.append(row);
		}
		this.contentEl.append(mask, paste, via); this.renderIssues();
	}

	protected renderMissingBoardNotice(): void {
		const notice = document.createElement('div'); notice.className = 'project-setup-planned';
		const title = document.createElement('h3'); title.textContent = 'No board file loaded';
		const text = document.createElement('p'); text.textContent = 'Open a project with a matching .kicad_pcb file to edit board-file-backed settings.';
		notice.append(title, text); this.contentEl.append(notice);
	}

	protected renderBoardDefaults(): void {
		const draft = this.draft!;
		const getNumber = (path: string, fallback: number): number => Number(draft.getBoardDesignValue(path, fallback));
		const getBool = (path: string, fallback: boolean): boolean => Boolean(draft.getBoardDesignValue(path, fallback));
		const set = (path: string, value: unknown): void => { draft.setBoardDesignValue(path, value); this.changed(); };
		this.pageHeading('Text & Graphics Defaults', 'Default geometry and text styles used when creating PCB items. Values are stored in millimeters.');

		const table = document.createElement('table');
		table.className = 'project-settings-table board-defaults-table';
		table.innerHTML = '<thead><tr><th>Layer class</th><th>Line width</th><th>Text width</th><th>Text height</th><th>Thickness</th><th>Italic</th><th>Upright</th></tr></thead>';
		const body = document.createElement('tbody');
		for (const [label, prefix, defaults] of [
			['Silkscreen', 'silk', [0.1, 1, 1, 0.1]],
			['Copper', 'copper', [0.2, 1.5, 1.5, 0.3]],
			['Fabrication', 'fab', [0.1, 1, 1, 0.15]],
			['Other', 'other', [0.1, 1, 1, 0.15]]
		] as const) {
			const tr = document.createElement('tr');
			const name = document.createElement('th'); name.textContent = label; tr.append(name);
			for (const [key, fallback] of [
				['line_width', defaults[0]], ['text_size_h', defaults[1]], ['text_size_v', defaults[2]], ['text_thickness', defaults[3]]
			] as const) {
				const td = document.createElement('td');
				td.append(numberInput(getNumber(`defaults.${ prefix }_${ key }`, fallback), value => set(`defaults.${ prefix }_${ key }`, value)));
				tr.append(td);
			}
			for (const key of ['italic', 'upright'] as const) {
				const td = document.createElement('td');
				td.append(checkboxInput(getBool(`defaults.${ prefix }_text_${ key }`, key === 'upright'), '', value => set(`defaults.${ prefix }_text_${ key }`, value)));
				tr.append(td);
			}
			body.append(tr);
		}
		table.append(body);

		const graphics = this.settingsGroup('Special Layer Widths');
		graphics.append(
			this.settingRow('Board outline line width (mm)', numberInput(getNumber('defaults.board_outline_line_width', 0.05), value => set('defaults.board_outline_line_width', value))),
			this.settingRow('Courtyard line width (mm)', numberInput(getNumber('defaults.courtyard_line_width', 0.05), value => set('defaults.courtyard_line_width', value)))
		);
		const pads = this.settingsGroup('Default Through-hole Pad');
		pads.append(
			this.settingRow('Width (mm)', numberInput(getNumber('defaults.pads.width', 1.5), value => set('defaults.pads.width', value))),
			this.settingRow('Height (mm)', numberInput(getNumber('defaults.pads.height', 1.5), value => set('defaults.pads.height', value))),
			this.settingRow('Drill (mm)', numberInput(getNumber('defaults.pads.drill', 0.8), value => set('defaults.pads.drill', value)))
		);
		const footprint = this.settingsGroup('Footprint Defaults');
		for (const [label, key] of [
			['Apply defaults to footprint fields', 'apply_defaults_to_fp_fields'],
			['Apply defaults to footprint text', 'apply_defaults_to_fp_text'],
			['Apply defaults to footprint shapes', 'apply_defaults_to_fp_shapes'],
			['Apply defaults to footprint dimensions', 'apply_defaults_to_fp_dimensions'],
			['Apply defaults to footprint barcodes', 'apply_defaults_to_fp_barcodes']
		] as const) footprint.append(checkboxInput(getBool(`defaults.${ key }`, false), label, value => set(`defaults.${ key }`, value)));
		this.contentEl.append(table, graphics, pads, footprint);
		this.renderIssues();
	}

	protected renderBoardFormatting(): void {
		const draft = this.draft!;
		const value = (path: string, fallback: unknown): unknown => draft.getBoardDesignValue(path, fallback);
		const set = (path: string, next: unknown): void => { draft.setBoardDesignValue(path, next); this.changed(); };
		this.pageHeading('PCB Formatting', 'Default dimension formatting and placement behavior used by newly created PCB dimensions.');
		const format = this.settingsGroup('Dimension Format');
		format.append(
			this.settingRow('Units', selectInput(Number(value('defaults.dimension_units', 3)), [
				['Inches', 0], ['Mils', 1], ['Millimeters', 2], ['Automatic', 3]
			], next => set('defaults.dimension_units', Number(next)))),
			this.settingRow('Precision', selectInput(Number(value('defaults.dimension_precision', 4)), [
				['0', 0], ['0.0', 1], ['0.00', 2], ['0.000', 3], ['0.0000', 4], ['0.00000', 5],
				['Variable 2', 6], ['Variable 3', 7], ['Variable 4', 8], ['Variable 5', 9]
			], next => set('defaults.dimension_precision', Number(next)))),
			this.settingRow('Units format', selectInput(Number(value('defaults.dimensions.units_format', 0)), [
				['No suffix', 0], ['Bare suffix', 1], ['Parenthesized suffix', 2]
			], next => set('defaults.dimensions.units_format', Number(next)))),
			this.settingRow('Text position', selectInput(Number(value('defaults.dimensions.text_position', 0)), [
				['Outside', 0], ['Inline', 1]
			], next => set('defaults.dimensions.text_position', Number(next))))
		);
		format.append(
			checkboxInput(Boolean(value('defaults.dimensions.suppress_zeroes', true)), 'Suppress trailing zeroes', next => set('defaults.dimensions.suppress_zeroes', next)),
			checkboxInput(Boolean(value('defaults.dimensions.keep_text_aligned', true)), 'Keep text aligned with dimension', next => set('defaults.dimensions.keep_text_aligned', next))
		);
		const geometry = this.settingsGroup('Dimension Geometry');
		geometry.append(
			this.settingRow('Arrow length (mm)', numberInput(Number(value('defaults.dimensions.arrow_length', 1270000)) / 1e6, next => set('defaults.dimensions.arrow_length', Math.round(next * 1e6)))),
			this.settingRow('Extension offset (mm)', numberInput(Number(value('defaults.dimensions.extension_offset', 500000)) / 1e6, next => set('defaults.dimensions.extension_offset', Math.round(next * 1e6))))
		);
		this.contentEl.append(format, geometry);
		this.renderIssues();
	}

	protected renderBoardConstraints(): void {
		const draft = this.draft!;
		const set = (path: string, next: unknown): void => { draft.setBoardDesignValue(path, next); this.changed(); };
		const number = (key: string, fallback: number, step = '0.01'): HTMLElement => numberInput(Number(draft.getBoardDesignValue(`rules.${ key }`, fallback)), next => set(`rules.${ key }`, next), step);
		this.pageHeading('Design Constraints', 'Global DRC and router constraint floors from KiCad Board Setup. All distances are millimeters.');
		const groups: Array<[string, Array<[string, string, number, string?]>]> = [
			['Copper', [
				['Minimum clearance', 'min_clearance', 0], ['Minimum connection width', 'min_connection', 0],
				['Minimum track width', 'min_track_width', 0], ['Copper to board edge', 'min_copper_edge_clearance', 0.5],
				['Maximum geometric error', 'max_error', 0.005, '0.0001']
			]],
			['Vias and holes', [
				['Minimum via annular width', 'min_via_annular_width', 0.05], ['Minimum via diameter', 'min_via_diameter', 0.5],
				['Minimum through-hole drill', 'min_through_hole_diameter', 0.3], ['Minimum microvia diameter', 'min_microvia_diameter', 0.2],
				['Minimum microvia drill', 'min_microvia_drill', 0.1], ['Minimum hole-to-hole', 'min_hole_to_hole', 0.25],
				['Minimum hole clearance', 'min_hole_clearance', 0.25]
			]],
			['Fabrication and text', [
				['Minimum silkscreen clearance', 'min_silk_clearance', 0], ['Minimum groove width', 'min_groove_width', 0],
				['Minimum text height', 'min_text_height', 0.8], ['Minimum text thickness', 'min_text_thickness', 0.08],
				['Solder mask to copper clearance', 'solder_mask_to_copper_clearance', 0]
			]]
		];
		for (const [title, fields] of groups) {
			const section = this.settingsGroup(title);
			for (const [label, key, fallback, step] of fields) section.append(this.settingRow(`${ label } (mm)`, number(key, fallback, step)));
			this.contentEl.append(section);
		}
		const thermal = this.settingsGroup('Thermal and Length Rules');
		thermal.append(
			this.settingRow('Minimum resolved spokes', number('min_resolved_spokes', 2, '1')),
			checkboxInput(Boolean(draft.getBoardDesignValue('rules.use_height_for_length_calcs', true)), 'Include track height in length calculations', next => set('rules.use_height_for_length_calcs', next))
		);
		this.contentEl.append(thermal);
		this.renderIssues();
	}

	protected renderPredefinedSizes(): void {
		const draft = this.draft!;
		this.pageHeading('Pre-defined Sizes', 'Track, via, and differential-pair presets shown by KiCad routing tools. Row zero represents net-class values.');
		const widths = draft.trackWidths.length ? [...draft.trackWidths] : [0];
		const widthSection = this.settingsGroup('Track Widths');
		widthSection.classList.add('project-settings-table-section');
		const widthTable = document.createElement('table'); widthTable.className = 'project-settings-table compact-size-table';
		widthTable.innerHTML = '<thead><tr><th>Preset</th><th>Width (mm)</th><th></th></tr></thead>';
		const widthBody = document.createElement('tbody');
		widths.forEach((width, index) => {
			const tr = document.createElement('tr'); const name = document.createElement('td'); name.textContent = index === 0 ? 'Net class' : String(index);
			const value = document.createElement('td');
			if (index === 0) value.textContent = '—'; else value.append(numberInput(width, next => { widths[index] = next; draft.setBoardDesignValue('track_widths', widths); this.changed(); }));
			const action = document.createElement('td'); if (index > 0) action.append(button('Remove', 'danger-link', () => { widths.splice(index, 1); draft.setBoardDesignValue('track_widths', widths); this.changed(); this.renderPage(); }));
			tr.append(name, value, action); widthBody.append(tr);
		});
		widthTable.append(widthBody); widthSection.append(widthTable, button('Add Track Width', '', () => { widths.push(0.25); draft.setBoardDesignValue('track_widths', widths); this.changed(); this.renderPage(); }));

		const vias = draft.viaDimensions.length ? draft.viaDimensions.map(row => ({ ...row })) : [{ diameter: 0, drill: 0 }];
		const viaSection = this.settingsGroup('Via Sizes');
		viaSection.classList.add('project-settings-table-section');
		viaSection.append(this.renderSizeRecordTable<ViaDimensionRecord>(vias, [['Diameter (mm)', 'diameter'], ['Drill (mm)', 'drill']], () => ({ diameter: 0.8, drill: 0.4 }), rows => draft.setBoardDesignValue('via_dimensions', rows)));
		const pairs = draft.diffPairDimensions.length ? draft.diffPairDimensions.map(row => ({ ...row })) : [{ width: 0, gap: 0, via_gap: 0 }];
		const pairSection = this.settingsGroup('Differential Pair Sizes');
		pairSection.classList.add('project-settings-table-section');
		pairSection.append(this.renderSizeRecordTable<DiffPairDimensionRecord>(pairs, [['Width (mm)', 'width'], ['Gap (mm)', 'gap'], ['Via gap (mm)', 'via_gap']], () => ({ width: 0.2, gap: 0.25, via_gap: 0.25 }), rows => draft.setBoardDesignValue('diff_pair_dimensions', rows)));
		this.contentEl.append(widthSection, viaSection, pairSection);
		this.renderIssues();
	}

	protected renderSizeRecordTable<T extends Record<string, unknown>>(
		rows: T[], fields: Array<[string, keyof T]>, create: () => T, commit: (rows: T[]) => void
	): HTMLElement {
		const wrap = document.createElement('div'); const table = document.createElement('table'); table.className = 'project-settings-table compact-size-table';
		const head = document.createElement('thead'); const header = document.createElement('tr');
		for (const caption of ['Preset', ...fields.map(field => field[0]), '']) { const th = document.createElement('th'); th.textContent = caption; header.append(th); }
		head.append(header); const body = document.createElement('tbody');
		rows.forEach((row, index) => {
			const tr = document.createElement('tr'); const name = document.createElement('td'); name.textContent = index === 0 ? 'Net class' : String(index); tr.append(name);
			for (const [, key] of fields) {
				const td = document.createElement('td');
				if (index === 0) td.textContent = '—'; else td.append(numberInput(row[key], next => { row[key] = next as T[keyof T]; commit(rows); this.changed(); }));
				tr.append(td);
			}
			const action = document.createElement('td'); if (index > 0) action.append(button('Remove', 'danger-link', () => { rows.splice(index, 1); commit(rows); this.changed(); this.renderPage(); })); tr.append(action); body.append(tr);
		});
		table.append(head, body); wrap.append(table, button('Add Preset', '', () => { rows.push(create()); commit(rows); this.changed(); this.renderPage(); })); return wrap;
	}

	protected renderZoneDefaults(): void {
		const draft = this.draft!;
		const get = (key: string, fallback: unknown): unknown => draft.getBoardDesignValue(`defaults.zones.${ key }`, fallback);
		const set = (key: string, value: unknown): void => { draft.setBoardDesignValue(`defaults.zones.${ key }`, value); this.changed(); };
		this.pageHeading('Zone Defaults', 'Defaults for newly created copper zones, matching KiCad’s polygon, hatch, thermal, and island controls.');
		const fill = this.settingsGroup('Fill');
		fill.append(
			this.settingRow('Fill mode', selectInput(Number(get('fill_mode', 0)), [['Solid polygons', 0], ['Hatched', 1], ['Copper thieving', 2]], value => set('fill_mode', Number(value)))),
			this.settingRow('Minimum clearance (mm)', numberInput(Number(get('min_clearance', 0.2)), value => set('min_clearance', value))),
			this.settingRow('Minimum thickness (mm)', numberInput(Number(get('min_thickness', 0.25)), value => set('min_thickness', value))),
			this.settingRow('Pad connection', selectInput(Number(get('pad_connection', 1)), [['Inherited', 0], ['Thermal relief', 1], ['Solid', 2], ['None', 3]], value => set('pad_connection', Number(value))))
		);
		const hatch = this.settingsGroup('Hatching');
		for (const [label, key, fallback] of [
			['Hatch thickness (mm)', 'hatch_thickness', 1], ['Hatch gap (mm)', 'hatch_gap', 1.5],
			['Hatch orientation (°)', 'hatch_orientation', 0], ['Hatch smoothing value', 'hatch_smoothing_value', 0.1],
			['Border hatch pitch (mm)', 'border_hatch_pitch', 0.5]
		] as const) hatch.append(this.settingRow(label, numberInput(Number(get(key, fallback)), value => set(key, value))));
		hatch.append(
			this.settingRow('Hatch smoothing', selectInput(Number(get('hatch_smoothing_level', 0)), [['None', 0], ['Fillet', 1], ['Arc minimum', 2]], value => set('hatch_smoothing_level', Number(value)))),
			this.settingRow('Border display', selectInput(Number(get('border_display_style', 2)), [['No hatch', 0], ['Diagonal edge', 1], ['Diagonal full', 2], ['Invisible border', 3]], value => set('border_display_style', Number(value))))
		);
		const thermal = this.settingsGroup('Thermals and Corners');
		thermal.append(
			this.settingRow('Thermal relief gap (mm)', numberInput(Number(get('thermal_relief_gap', 0.5)), value => set('thermal_relief_gap', value))),
			this.settingRow('Thermal spoke width (mm)', numberInput(Number(get('thermal_relief_spoke_width', 0.5)), value => set('thermal_relief_spoke_width', value))),
			this.settingRow('Corner smoothing', selectInput(Number(get('corner_smoothing', 0)), [['None', 0], ['Chamfer', 1], ['Fillet', 2]], value => set('corner_smoothing', Number(value)))),
			this.settingRow('Corner radius (mm)', numberInput(Number(get('corner_radius', 0)), value => set('corner_radius', value))),
			checkboxInput(Boolean(draft.getBoardDesignValue('zones_allow_external_fillets', false)), 'Allow external fillets', value => { draft.setBoardDesignValue('zones_allow_external_fillets', value); this.changed(); })
		);
		const islands = this.settingsGroup('Islands');
		islands.append(
			this.settingRow('Island removal', selectInput(Number(get('remove_islands', 0)), [['Always remove', 0], ['Never remove', 1], ['Below area limit', 2]], value => set('remove_islands', Number(value)))),
			this.settingRow('Minimum island area (mm²)', numberInput(Number(get('min_island_area', 10)), value => set('min_island_area', value)))
		);
		this.contentEl.append(fill, hatch, thermal, islands); this.renderIssues();
	}

	protected renderTeardrops(): void {
		const draft = this.draft!;
		this.pageHeading('Teardrops', 'Global targets and the three KiCad parameter sets for round pads/vias, rectangular pads, and track ends.');
		const targets = this.settingsGroup('Targets');
		for (const [label, key, fallback] of [
			['Vias', 'td_onvia', true], ['Through-hole pads', 'td_onpthpad', true], ['SMD pads', 'td_onsmdpad', true],
			['Track ends', 'td_ontrackend', false], ['Round shapes only', 'td_onroundshapesonly', false]
		] as const) targets.append(checkboxInput(Boolean(draft.teardropOptions[key] ?? fallback), label, value => { draft.setTeardropOption(key, value); this.changed(); }));
		this.contentEl.append(targets);
		const parameters = draft.teardropParameters.length ? draft.teardropParameters : [
			this.defaultTeardropParameter('td_round_shape'), this.defaultTeardropParameter('td_rect_shape'), this.defaultTeardropParameter('td_track_end')
		];
		const commit = (): void => { draft.setBoardDesignValue('teardrop_parameters', parameters); this.changed(); };
		for (const parameter of parameters) this.contentEl.append(this.renderTeardropCard(parameter, commit));
		this.renderIssues();
	}

	protected defaultTeardropParameter(target: string): TeardropParameterRecord {
		return {
			td_target_name: target, td_maxlen: 1, td_maxheight: 2, td_length_ratio: 0.5,
			td_height_ratio: 1, td_curve_segcount: 0, td_width_to_size_filter_ratio: 0.9,
			td_allow_use_two_tracks: true, td_on_pad_in_zone: false
		};
	}

	protected renderTeardropCard(parameter: TeardropParameterRecord, onMutate: () => void): HTMLElement {
		const labels: Record<string, string> = { td_round_shape: 'Round Pads and Vias', td_rect_shape: 'Rectangular Pads', td_track_end: 'Track Ends' };
		const card = document.createElement('section'); card.className = 'project-settings-card';
		const title = document.createElement('h3'); title.textContent = labels[parameter.td_target_name] ?? parameter.td_target_name; card.append(title);
		const form = document.createElement('div'); form.className = 'project-settings-form-grid';
		for (const [label, key, step] of [
			['Maximum length (mm)', 'td_maxlen', '0.01'], ['Maximum width (mm)', 'td_maxheight', '0.01'],
			['Best length ratio', 'td_length_ratio', '0.01'], ['Best width ratio', 'td_height_ratio', '0.01'],
			['Width-to-size filter ratio', 'td_width_to_size_filter_ratio', '0.01']
		] as const) form.append(this.settingRow(label, numberInput(parameter[key], value => { parameter[key] = value; onMutate(); }, step)));
		form.append(this.settingRow('Edge style', selectInput(parameter.td_curve_segcount > 0 ? 1 : 0, [['Straight', 0], ['Curved', 1]], value => { parameter.td_curve_segcount = Number(value); onMutate(); })));
		const checks = document.createElement('div'); checks.className = 'project-settings-check-row';
		checks.append(
			checkboxInput(Boolean(parameter.td_allow_use_two_tracks), 'Allow two connected tracks', value => { parameter.td_allow_use_two_tracks = value; onMutate(); }),
			checkboxInput(Boolean(parameter.td_on_pad_in_zone), 'Create on pads in zones', value => { parameter.td_on_pad_in_zone = value; onMutate(); })
		);
		card.append(form, checks); return card;
	}

	protected renderLengthTuning(): void {
		const draft = this.draft!;
		const all = draft.tuningPatternSettings;
		this.pageHeading('Length-tuning Patterns', 'Default meander geometry for single tracks, differential pairs, and differential-pair skew tuning.');
		for (const [key, title, spacing] of [
			['single_track_defaults', 'Single Track', 0.6], ['diff_pair_defaults', 'Differential Pair', 1], ['diff_pair_skew_defaults', 'Differential Pair Skew', 0.6]
		] as const) {
			const settings: Record<string, unknown> = { min_amplitude: 0.2, max_amplitude: 1, spacing, corner_style: 1, corner_radius_percentage: 80, single_sided: false, ...(all[key] ?? {}) };
			const commit = (): void => { draft.setBoardDesignValue(`tuning_pattern_settings.${ key }`, settings); this.changed(); };
			const card = document.createElement('section'); card.className = 'project-settings-card'; const heading = document.createElement('h3'); heading.textContent = title;
			const form = document.createElement('div'); form.className = 'project-settings-form-grid';
			for (const [label, field, step] of [
				['Minimum amplitude (mm)', 'min_amplitude', '0.01'], ['Maximum amplitude (mm)', 'max_amplitude', '0.01'],
				['Spacing (mm)', 'spacing', '0.01'], ['Corner radius (%)', 'corner_radius_percentage', '1']
			] as const) form.append(this.settingRow(label, numberInput(settings[field], value => { settings[field] = value; commit(); }, step)));
			form.append(this.settingRow('Corner style', selectInput(Number(settings.corner_style), [['Chamfer', 0], ['Rounded', 1]], value => { settings.corner_style = Number(value); commit(); })));
			card.append(heading, form, checkboxInput(Boolean(settings.single_sided), 'Single-sided meander', value => { settings.single_sided = value; commit(); }));
			this.contentEl.append(card);
		}
		this.renderIssues();
	}

	protected renderDrcSeverity(): void {
		const severities = this.draft!.drcRuleSeverities;
		this.pageHeading('DRC Violation Severity', 'Every board DRC rule in the loaded project. Unknown future values remain selectable and are preserved.');
		const table = document.createElement('table'); table.className = 'project-settings-table erc-severity-table';
		table.innerHTML = '<thead><tr><th>Violation</th><th>Settings key</th><th>Severity</th></tr></thead>';
		const body = document.createElement('tbody');
		for (const key of Object.keys(severities).sort((a, b) => a.localeCompare(b))) {
			const tr = document.createElement('tr'); const label = document.createElement('td'); label.textContent = key.replaceAll('_', ' ').replace(/\b\w/g, value => value.toUpperCase());
			const raw = document.createElement('td'); raw.textContent = key; raw.className = 'project-settings-mono'; const choice = document.createElement('td');
			const current = severities[key]!; const options: Array<readonly [string, string]> = [['Ignore', 'ignore'], ['Warning', 'warning'], ['Error', 'error']];
			if (!options.some(([, value]) => value === current)) options.unshift([`Preserve unknown value (${ current })`, current]);
			choice.append(selectInput(current, options, value => { this.draft!.setDrcRuleSeverity(key, value); this.changed(); }));
			tr.append(label, raw, choice); body.append(tr);
		}
		table.append(body); this.contentEl.append(table); this.renderIssues();
	}

	protected renderCustomRules(): void {
		this.pageHeading('Custom Rules', 'Free-form KiCad custom design rules (.kicad_dru) — the same syntax as Board Setup > Custom Rules in desktop KiCad. Syntax is not checked here yet; invalid rules are simply ignored by KiCad’s DRC engine.');
		if (!this.draft!.hasRulesFile) {
			const hint = document.createElement('p');
			hint.className = 'project-setup-hint';
			hint.textContent = 'No custom rules file exists yet for this project — start typing to create one.';
			this.contentEl.append(hint);
		}
		const textarea = textareaInput(this.draft!.rulesText, value => { this.draft!.setRulesText(value); this.changed(); });
		textarea.className = 'project-setup-rules-editor';
		this.contentEl.append(textarea);
		this.renderIssues();
	}

	protected renderEmbeddedFilesPage(kind: 'board' | 'schematic'): void {
		const draft = this.draft!;
		const label = kind === 'board' ? 'Board' : 'Schematic';
		this.pageHeading(
			`${ label } Data / Embedded Files`,
			`Binary files (3D models, fonts, worksheets, datasheets) embedded directly in the ${ label.toLowerCase() } file, matching KiCad 9+’s Embedded Files feature.`
		);

		const hasFile = kind === 'board' ? draft.hasBoard : draft.hasSchematic;
		if (!hasFile) {
			const hint = document.createElement('p');
			hint.className = 'project-setup-hint';
			hint.textContent = `This project has no ${ label.toLowerCase() } file to embed files into.`;
			this.contentEl.append(hint);
			return;
		}

		const files = kind === 'board' ? draft.boardEmbeddedFiles : draft.schematicEmbeddedFiles;
		const table = document.createElement('table');
		table.className = 'project-settings-table';
		table.innerHTML = '<thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Checksum</th><th></th></tr></thead>';
		const body = document.createElement('tbody');
		for (const file of files) {
			const tr = document.createElement('tr');
			const nameCell = document.createElement('td');
			nameCell.textContent = file.getName();
			const typeCell = document.createElement('td');
			typeCell.textContent = file.getType();
			const sizeCell = document.createElement('td');
			sizeCell.textContent = formatFileSize(file.getDataBytes().length);
			const checksumCell = document.createElement('td');
			checksumCell.className = 'project-settings-mono';
			checksumCell.textContent = file.getChecksum();
			const actionCell = document.createElement('td');
			actionCell.append(
				button('Download', '', () => this.downloadEmbeddedFile(file)),
				button('Remove', 'danger-link', () => {
					const removed = kind === 'board'
						? draft.removeBoardEmbeddedFile(file.getName())
						: draft.removeSchematicEmbeddedFile(file.getName());
					if (removed) {
						this.changed();
						this.renderPage();
					}
				})
			);
			tr.append(nameCell, typeCell, sizeCell, checksumCell, actionCell);
			body.append(tr);
		}
		table.append(body);
		this.contentEl.append(table);

		const addLabel = document.createElement('label');
		addLabel.className = 'project-setup-file-btn';
		addLabel.textContent = 'Add File(s)';
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.multiple = true;
		fileInput.hidden = true;
		fileInput.addEventListener('change', () => {
			const selected = Array.from(fileInput.files ?? []);
			fileInput.value = '';
			if (selected.length) void this.addEmbeddedFiles(kind, selected);
		});
		addLabel.append(fileInput);
		this.contentEl.append(addLabel);
		this.renderIssues();
	}

	protected async addEmbeddedFiles(kind: 'board' | 'schematic', files: File[]): Promise<void> {
		const draft = this.draft!;
		for (const file of files) {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const type = guessEmbeddedFileType(file.name);
			if (kind === 'board') draft.addBoardEmbeddedFile(file.name, type, bytes);
			else draft.addSchematicEmbeddedFile(file.name, type, bytes);
		}
		this.changed();
		this.renderPage();
	}

	/** Real KiCad's own embedded-files dialog doesn't reference-check before
	 *  removal either (common/dialogs/panel_embedded_files.cpp) — deletion
	 *  just removes the entry, so an orphaned `kicad-embed://` reference
	 *  elsewhere in the file is possible in real KiCad too; this matches
	 *  that rather than adding tracking real KiCad itself doesn't have. */
	protected downloadEmbeddedFile(file: KicadElementEmbeddedFile): void {
		let bytes: Uint8Array;
		try {
			bytes = decompress(file.getDataBytes());
		}
		catch (error) {
			this.deps.setStatus(`Could not decompress “${ file.getName() }” — ${ error instanceof Error ? error.message : String(error) }`);
			return;
		}
		const checksum = mmh3Hash128Hex(bytes);
		if (checksum !== file.getChecksum()) {
			this.deps.setStatus(`Warning: “${ file.getName() }” checksum mismatch (stored ${ file.getChecksum() }, computed ${ checksum }) — the embedded data may be corrupt.`);
		}
		const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = file.getName();
		link.click();
		URL.revokeObjectURL(url);
	}

	protected renderPlannedPage(): void {
		const definition = PAGES.find(item => item.id === this.page)!;
		this.pageHeading(definition.label, `${ definition.group } settings from KiCad's setup dialogs.`);
		const notice = document.createElement('div');
		notice.className = 'project-setup-planned';
		const title = document.createElement('h3');
		title.textContent = `Planned for Phase ${ definition.phase }`;
		const text = document.createElement('p');
		text.textContent = 'This page is intentionally read-only until its typed, lossless KiCad storage adapter and validation are implemented.';
		notice.append(title, text);
		this.contentEl.append(notice);
	}

	protected changed(): void {
		this.uiIssues = [];
		this.updateChrome();
		this.renderIssues();
	}

	protected collectIssues(): ValidationIssue[] {
		return [...this.uiIssues, ...this.validateLocalRows(), ...(this.draft?.validate() ?? [])];
	}

	protected validateLocalRows(): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const variableNames = new Set<string>();
		for (const row of this.textVariableRows) {
			if (variableNames.has(row.name)) issues.push({ path: 'text_variables', message: `Text variable “${ row.name }” is duplicated.` });
			variableNames.add(row.name);
		}
		const assignments = new Set<string>();
		for (const row of this.assignmentRows) {
			const key = `${ row.net }\u0000${ row.netclass }`;
			if (assignments.has(key)) issues.push({ path: 'net_settings.netclass_assignments', message: `Net “${ row.net }” is assigned to “${ row.netclass }” more than once.` });
			assignments.add(key);
		}
		const coloredNets = new Set<string>();
		for (const row of this.netColorRows) {
			if (!row.net.trim()) issues.push({ path: 'net_settings.net_colors', message: 'Net color assignments need a net name.' });
			else if (coloredNets.has(row.net)) issues.push({ path: 'net_settings.net_colors', message: `Net color for “${ row.net }” is duplicated.` });
			if (!row.color.trim()) issues.push({ path: 'net_settings.net_colors', message: `Net “${ row.net || '(unnamed)' }” needs a color.` });
			coloredNets.add(row.net);
		}
		const aliasNames = new Set<string>();
		for (const row of this.busAliasRows) {
			if (!row.name.trim()) issues.push({ path: 'schematic.bus_aliases', message: 'Bus alias names cannot be empty.' });
			else if (aliasNames.has(row.name)) issues.push({ path: 'schematic.bus_aliases', message: `Bus alias “${ row.name }” is duplicated.` });
			if (!row.members.split(',').some(member => member.trim())) issues.push({ path: 'schematic.bus_aliases', message: `Bus alias “${ row.name || '(unnamed)' }” needs at least one member.` });
			aliasNames.add(row.name);
		}
		const chainNames = new Set<string>();
		for (const row of this.netChainRows) {
			if (!row.chain.trim()) issues.push({ path: 'net_settings.net_chain_classes', message: 'Net chain names cannot be empty.' });
			else if (chainNames.has(row.chain)) issues.push({ path: 'net_settings.net_chain_classes', message: `Net chain “${ row.chain }” is duplicated.` });
			chainNames.add(row.chain);
		}
		for (const [rows, label, path] of [
			[this.symbolLibraryRows, 'Pinned symbol library', 'libraries.pinned_symbol_libs'],
			[this.footprintLibraryRows, 'Pinned footprint library', 'libraries.pinned_footprint_libs']
		] as const) {
			const names = new Set<string>();
			for (const value of rows) {
				if (!value.trim()) issues.push({ path, message: `${ label } cannot be empty.` });
				else if (names.has(value)) issues.push({ path, message: `${ label } “${ value }” is duplicated.` });
				names.add(value);
			}
		}
		return issues;
	}

	protected hasPendingLocalRows(): boolean {
		const draftVariables = Object.entries(this.draft?.textVariables ?? {}).map(([name, value]) => ({ name, value }));
		const draftAssignments = Object.entries(this.draft?.netClassAssignments ?? {})
			.flatMap(([net, netclasses]) => netclasses.map(netclass => ({ net, netclass })));
		const draftNetColors = Object.entries(this.draft?.netColors ?? {}).map(([net, color]) => ({ net, color }));
		const draftAliases = Object.entries(this.draft?.busAliases ?? {})
			.map(([name, members]) => ({ name, members: members.join(', ') }));
		const draftChains = Object.entries(this.draft?.netChainClasses ?? {})
			.map(([chain, netclass]) => ({ chain, netclass }));
		return JSON.stringify(this.textVariableRows) !== JSON.stringify(draftVariables)
			|| JSON.stringify(this.assignmentRows) !== JSON.stringify(draftAssignments)
			|| JSON.stringify(this.netColorRows) !== JSON.stringify(draftNetColors)
			|| JSON.stringify(this.busAliasRows) !== JSON.stringify(draftAliases)
			|| JSON.stringify(this.netChainRows) !== JSON.stringify(draftChains)
			|| JSON.stringify(this.symbolLibraryRows) !== JSON.stringify(this.draft?.pinnedSymbolLibraries ?? [])
			|| JSON.stringify(this.footprintLibraryRows) !== JSON.stringify(this.draft?.pinnedFootprintLibraries ?? []);
	}

	protected renderIssues(): void {
		this.contentEl.querySelector('.project-setup-errors')?.remove();
		const issues = this.collectIssues();
		if (!issues.length) return;
		const box = document.createElement('div');
		box.className = 'project-setup-errors';
		const title = document.createElement('strong');
		title.textContent = 'Resolve before applying:';
		const list = document.createElement('ul');
		for (const issue of issues.slice(0, 8)) {
			const item = document.createElement('li');
			item.textContent = issue.message;
			list.append(item);
		}
		box.append(title, list);
		this.contentEl.append(box);
	}

	protected updateChrome(): void {
		if (!this.applyButton) return;
		const dirty = this.isDirty;
		this.dirtyEl.textContent = dirty ? '● Unapplied changes' : 'Saved';
		this.dirtyEl.classList.toggle('active', dirty);
		this.applyButton.disabled = !dirty || !!this.context?.readOnly || this.collectIssues().length > 0;
		this.revertButton.disabled = !dirty;
	}

	protected revert(): void {
		if (!this.draft || !this.isDirty) return;
		if (!window.confirm('Revert all unapplied Project Setup changes?')) return;
		this.draft.reset();
		this.syncLocalRows();
		this.selectedNetClass = 0;
		this.renderPage();
		this.updateChrome();
		this.deps.setStatus('Project Setup changes reverted.');
	}

	protected async apply(): Promise<void> {
		const projectFile = this.context?.project.projectFile;
		if (!this.draft || !projectFile || !this.context?.fsAdapter) return;
		const issues = this.collectIssues();
		if (issues.length) {
			this.deps.setStatus(issues[0]!.message);
			this.renderIssues();
			return;
		}
		this.applyButton.disabled = true;
		// Captured before draft.apply() runs — a successful apply resets the
		// draft's internal board snapshot to the just-saved text, so isBoardDirty
		// would read false again afterwards even though the board file changed.
		const boardChanged = this.draft.isBoardDirty;
		try {
			projectFile.saveFile = this.context.fsAdapter.saveFile;
			const board = this.context.project.mainBoard;
			if (board) board.saveFile = this.context.fsAdapter.saveFile;
			const designRules = this.context.project.designRules;
			if (designRules) designRules.saveFile = this.context.fsAdapter.saveFile;
			const schematic = this.context.project.mainSchematic;
			if (schematic) schematic.saveFile = this.context.fsAdapter.saveFile;
			await this.draft.apply(projectFile, board, designRules, schematic);
			this.syncLocalRows();
			// Custom Rules shows a "no file yet" hint driven by original
			// (pre-apply) state — a successful Apply can flip that (creating
			// the file for the first time), so this page specifically needs
			// a re-render to stop showing the stale hint. Every other page's
			// fields are edited in place already and don't need this.
			if (this.page === 'custom-rules') {
				this.contentEl.replaceChildren();
				this.renderCustomRules();
			}
			this.deps.onApplied(boardChanged);
			this.deps.setStatus('Project settings applied and saved.');
		}
		catch (error) {
			this.deps.setStatus(`Could not apply project settings — ${ error instanceof Error ? error.message : String(error) }`);
		}
		finally {
			this.updateChrome();
			this.renderIssues();
		}
	}
}
