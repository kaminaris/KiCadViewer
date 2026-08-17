import type { KicadProjectFile } from '@kicad-io/Project/KicadProjectFile';
import type { KicadBoard } from '@kicad-io/Project/KicadBoard';
import type { KicadSchematic } from '@kicad-io/Project/KicadSchematic';
import type { KicadDesignRulesFile } from '@kicad-io/Project/KicadDesignRulesFile';
import { KicadParser } from '@kicad-io/KicadParser';
import { KicadElement } from '@kicad-io/KicadElement';
import { KicadElementLayer } from '@kicad-io/KicadElementLayer';
import { KicadElementLayers, type KicadLayerDefinition, type KicadLayerType } from '@kicad-io/KicadElementLayers';
import { KicadElementSetup, KicadElementStackup } from '@kicad-io/KicadElementSetup';
import { KicadElementThickness } from '@kicad-io/KicadElementNumeric';
import { KicadElementEmbeddedFile, KicadElementEmbeddedFiles } from '@kicad-io/KicadElementEmbeddedFiles';
import { mmh3Hash128Hex } from '@kicad-io/Project/EmbeddedFileHash';
import { encodeRawFrame } from '@zstd-ts/encodeRaw';

export interface ValidationIssue {
	path: string;
	message: string;
}

export interface NetClassRecord extends Record<string, unknown> {
	name: string;
	priority?: number;
	clearance?: number;
	track_width?: number;
	via_diameter?: number;
	via_drill?: number;
	microvia_diameter?: number;
	microvia_drill?: number;
	diff_pair_width?: number;
	diff_pair_gap?: number;
	diff_pair_via_gap?: number;
	wire_width?: number;
	bus_width?: number;
	line_style?: number;
	pcb_color?: string;
	schematic_color?: string;
	tuning_profile?: string;
}

export interface NetClassPattern extends Record<string, unknown> {
	pattern: string;
	netclass: string;
}

export interface ComponentClassAssignment extends Record<string, unknown> {
	component_class: string;
	conditions_operator: 'ALL' | 'ANY';
	conditions: Record<string, { primary?: string; secondary?: string }>;
}

export interface TuningProfileRecord extends Record<string, unknown> {
	profile_name: string;
	type: number;
	target_impedance: number;
	frequency: number;
	model_solder_mask: boolean;
	enable_time_domain_tuning: boolean;
	layer_entries: Array<Record<string, unknown>>;
	via_prop_delay: number;
	via_overrides: Array<Record<string, unknown>>;
}

export interface FieldNameTemplateRecord extends Record<string, unknown> {
	name: string;
	visible: boolean;
	url: boolean;
}

export interface BomFieldRecord extends Record<string, unknown> {
	name: string;
	label: string;
	show: boolean;
	group_by: boolean;
}

export interface BomPresetRecord extends Record<string, unknown> {
	name: string;
	fields_ordered: BomFieldRecord[];
	sort_field: string;
	sort_asc: boolean;
	filter_string: string;
	group_symbols: boolean;
	exclude_dnp: boolean;
	include_excluded_from_bom: boolean;
}

export interface BomFormatPresetRecord extends Record<string, unknown> {
	name: string;
	field_delimiter: string;
	string_delimiter: string;
	ref_delimiter: string;
	ref_range_delimiter: string;
	keep_tabs: boolean;
	keep_line_breaks: boolean;
}

export interface ViaDimensionRecord extends Record<string, unknown> {
	diameter: number;
	drill: number;
}

export interface DiffPairDimensionRecord extends Record<string, unknown> {
	width: number;
	gap: number;
	via_gap: number;
}

export interface TeardropParameterRecord extends Record<string, unknown> {
	td_target_name: string;
	td_maxlen: number;
	td_maxheight: number;
	td_length_ratio: number;
	td_height_ratio: number;
	td_curve_segcount: number;
	td_width_to_size_filter_ratio: number;
	td_allow_use_two_tracks: boolean;
	td_on_pad_in_zone: boolean;
}

export interface StackupLayerRecord {
	index: number;
	name: string;
	type: string;
	thickness?: number;
	material?: string;
	color?: string;
	epsilonR?: number;
	lossTangent?: number;
	lockThickness?: boolean;
}

const DEFAULT_PIN_MAP = [
	[0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2],
	[0, 2, 0, 1, 0, 0, 1, 0, 2, 2, 2, 2],
	[0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 2],
	[0, 1, 0, 0, 0, 0, 1, 1, 2, 1, 1, 2],
	[0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2],
	[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
	[1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 2],
	[0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2],
	[0, 2, 1, 2, 0, 0, 1, 0, 2, 2, 2, 2],
	[0, 2, 0, 1, 0, 0, 1, 0, 2, 0, 0, 2],
	[0, 2, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2],
	[2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]
] as const;

const DEFAULT_BOM_SETTINGS: BomPresetRecord = {
	name: '', fields_ordered: [], sort_field: 'Reference', sort_asc: true,
	filter_string: '', group_symbols: true, exclude_dnp: false,
	include_excluded_from_bom: false
};

const DEFAULT_BOM_FORMAT_SETTINGS: BomFormatPresetRecord = {
	name: 'CSV', field_delimiter: ',', string_delimiter: '"', ref_delimiter: ',',
	ref_range_delimiter: '', keep_tabs: false, keep_line_breaks: false
};

const DEFAULT_NET_CLASS: NetClassRecord = {
	name: 'Default',
	priority: 2147483647,
	clearance: 0.2,
	track_width: 0.25,
	via_diameter: 0.8,
	via_drill: 0.4,
	microvia_diameter: 0.3,
	microvia_drill: 0.1,
	diff_pair_width: 0.2,
	diff_pair_gap: 0.25,
	diff_pair_via_gap: 0.25,
	wire_width: 6,
	bus_width: 12,
	line_style: 0,
	pcb_color: 'rgba(0, 0, 0, 0.000)',
	schematic_color: 'rgba(0, 0, 0, 0.000)',
	tuning_profile: ''
};

function clone<T>(value: T): T {
	return structuredClone(value);
}

function stableJson(value: unknown): string {
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Lossless `.kicad_pro` draft. Typed pages mutate only the cloned subtrees
 * they own; every unknown key from current or future KiCad versions remains
 * present. The live KicadProjectFile is replaced only after validation and a
 * source-revision check, so merely opening Project Setup can never dirty or
 * rewrite the project.
 */
export class ProjectSettingsDraft {
	protected original: Record<string, unknown>;
	protected originalJson: string;
	protected draft: Record<string, unknown>;
	protected originalBoardText: string | null = null;
	protected draftBoardRoot: KicadElement | null = null;
	protected originalSchematicText: string | null = null;
	protected draftSchematicRoot: KicadElement | null = null;
	protected originalRulesText: string | null = null;
	protected draftRulesText: string | null = null;

	constructor(
		source: Record<string, unknown>, board?: KicadBoard, designRules?: KicadDesignRulesFile,
		schematic?: KicadSchematic
	) {
		this.original = clone(source);
		this.originalJson = stableJson(source);
		this.draft = clone(source);
		if (board?.rootElement) {
			this.originalBoardText = board.rootElement.write();
			this.draftBoardRoot = this.parseBoard(this.originalBoardText);
		}
		if (schematic?.rootElement) {
			this.originalSchematicText = schematic.rootElement.write();
			this.draftSchematicRoot = this.parseBoard(this.originalSchematicText);
		}
		this.originalRulesText = designRules?.loaded ? designRules.data : null;
		this.draftRulesText = this.originalRulesText;
	}

	get isDirty(): boolean {
		return stableJson(this.draft) !== stableJson(this.original)
			|| this.isBoardDirty || this.isSchematicDirty || this.isRulesDirty;
	}

	get isBoardDirty(): boolean {
		return !!this.draftBoardRoot && this.draftBoardRoot.write() !== this.originalBoardText;
	}

	get hasBoard(): boolean {
		return !!this.draftBoardRoot;
	}

	get isSchematicDirty(): boolean {
		return !!this.draftSchematicRoot && this.draftSchematicRoot.write() !== this.originalSchematicText;
	}

	get hasSchematic(): boolean {
		return !!this.draftSchematicRoot;
	}

	/** `.kicad_dru` custom rules — free text, no parsing/validation yet (see
	 *  ProjectSetupPlan.md's Data Ownership table: "lossless text document
	 *  first; syntax-aware validation and editor diagnostics second"). */
	get rulesText(): string {
		return this.draftRulesText ?? '';
	}

	/** Whether an existing `.kicad_dru` was read from disk — false for a
	 *  project that's never had one, even after the user starts typing
	 *  (isRulesDirty covers that case; this only reflects the ORIGINAL
	 *  on-disk state, matching hasBoard's own "still describes what was
	 *  loaded" semantics). */
	get hasRulesFile(): boolean {
		return this.originalRulesText !== null;
	}

	get isRulesDirty(): boolean {
		return (this.draftRulesText ?? '') !== (this.originalRulesText ?? '');
	}

	setRulesText(text: string): void {
		this.draftRulesText = text;
	}

	get textVariables(): Record<string, string> {
		return isRecord(this.draft.text_variables)
			? this.draft.text_variables as Record<string, string>
			: {};
	}

	setTextVariables(rows: ReadonlyArray<{ name: string; value: string }>): void {
		this.draft.text_variables = Object.fromEntries(rows.map(row => [row.name, row.value]));
	}

	get netClasses(): NetClassRecord[] {
		const settings = isRecord(this.draft.net_settings) ? this.draft.net_settings : null;
		return Array.isArray(settings?.classes) ? settings.classes as NetClassRecord[] : [];
	}

	get netClassPatterns(): NetClassPattern[] {
		const settings = isRecord(this.draft.net_settings) ? this.draft.net_settings : null;
		return Array.isArray(settings?.netclass_patterns) ? settings.netclass_patterns as NetClassPattern[] : [];
	}

	get netClassAssignments(): Record<string, string[]> {
		const settings = isRecord(this.draft.net_settings) ? this.draft.net_settings : null;
		if (!isRecord(settings?.netclass_assignments)) return {};
		return Object.fromEntries(Object.entries(settings.netclass_assignments).map(([net, value]) => [
			net,
			Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
		]));
	}

	setNetClassAssignments(rows: ReadonlyArray<{ net: string; netclass: string }>): void {
		const settings = this.ensureNetSettings();
		const grouped: Record<string, string[]> = {};
		for (const row of rows) {
			(grouped[row.net] ??= []).push(row.netclass);
		}
		settings.netclass_assignments = rows.length ? grouped : null;
	}

	get netColors(): Record<string, string> {
		const settings = isRecord(this.draft.net_settings) ? this.draft.net_settings : null;
		if (!isRecord(settings?.net_colors)) return {};
		return Object.fromEntries(Object.entries(settings.net_colors).map(([net, color]) => [net, String(color)]));
	}

	setNetColors(rows: ReadonlyArray<{ net: string; color: string }>): void {
		this.ensureNetSettings().net_colors = rows.length ? Object.fromEntries(rows.map(row => [row.net, row.color])) : null;
	}

	get busAliases(): Record<string, string[]> {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		if (!isRecord(schematic?.bus_aliases)) return {};
		return Object.fromEntries(Object.entries(schematic.bus_aliases).map(([name, members]) => [
			name, Array.isArray(members) ? members.map(String) : []
		]));
	}

	setBusAliases(rows: ReadonlyArray<{ name: string; members: string[] }>): void {
		const schematic = this.ensureRecord('schematic');
		schematic.bus_aliases = Object.fromEntries(rows.map(row => [row.name, row.members]));
	}

	get pinnedSymbolLibraries(): string[] {
		const libraries = isRecord(this.draft.libraries) ? this.draft.libraries : null;
		return Array.isArray(libraries?.pinned_symbol_libs) ? libraries.pinned_symbol_libs.map(String) : [];
	}

	get pinnedFootprintLibraries(): string[] {
		const libraries = isRecord(this.draft.libraries) ? this.draft.libraries : null;
		return Array.isArray(libraries?.pinned_footprint_libs) ? libraries.pinned_footprint_libs.map(String) : [];
	}

	setPinnedLibraries(symbols: string[], footprints: string[]): void {
		const libraries = this.ensureRecord('libraries');
		libraries.pinned_symbol_libs = [...symbols];
		libraries.pinned_footprint_libs = [...footprints];
	}

	get netChainClasses(): Record<string, string> {
		const settings = isRecord(this.draft.net_settings) ? this.draft.net_settings : null;
		if (!isRecord(settings?.net_chain_classes)) return {};
		return Object.fromEntries(Object.entries(settings.net_chain_classes).map(([chain, className]) => [chain, String(className)]));
	}

	setNetChainClasses(rows: ReadonlyArray<{ chain: string; netclass: string }>): void {
		this.ensureNetSettings().net_chain_classes = Object.fromEntries(rows.map(row => [row.chain, row.netclass]));
	}

	get sheetComponentClassesEnabled(): boolean {
		const settings = isRecord(this.draft.component_class_settings) ? this.draft.component_class_settings : null;
		return isRecord(settings?.sheet_component_classes) && settings.sheet_component_classes.enabled === true;
	}

	setSheetComponentClassesEnabled(enabled: boolean): void {
		const settings = this.ensureRecord('component_class_settings');
		const sheetSettings = isRecord(settings.sheet_component_classes) ? settings.sheet_component_classes : {};
		sheetSettings.enabled = enabled;
		settings.sheet_component_classes = sheetSettings;
	}

	get componentClassAssignments(): ComponentClassAssignment[] {
		const settings = isRecord(this.draft.component_class_settings) ? this.draft.component_class_settings : null;
		return Array.isArray(settings?.assignments) ? settings.assignments as ComponentClassAssignment[] : [];
	}

	addComponentClassAssignment(): ComponentClassAssignment {
		const settings = this.ensureRecord('component_class_settings');
		if (!Array.isArray(settings.assignments)) settings.assignments = [];
		const assignment: ComponentClassAssignment = {
			component_class: '', conditions_operator: 'ALL', conditions: { REFERENCE: { primary: '' } }
		};
		(settings.assignments as ComponentClassAssignment[]).push(assignment);
		return assignment;
	}

	get tuningProfiles(): TuningProfileRecord[] {
		const settings = isRecord(this.draft.tuning_profiles) ? this.draft.tuning_profiles : null;
		return Array.isArray(settings?.tuning_profiles_impedance_geometric)
			? settings.tuning_profiles_impedance_geometric as TuningProfileRecord[] : [];
	}

	get schematicDrawing(): Record<string, unknown> {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return isRecord(schematic?.drawing) ? schematic.drawing : {};
	}

	setSchematicDrawingValue(key: string, value: unknown): void {
		const schematic = this.ensureRecord('schematic');
		if (!isRecord(schematic.drawing)) schematic.drawing = {};
		(schematic.drawing as Record<string, unknown>)[key] = value;
	}

	getSchematicValue(key: string, fallback: unknown): unknown {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return schematic && key in schematic ? schematic[key] : fallback;
	}

	setSchematicValue(key: string, value: unknown): void {
		this.ensureRecord('schematic')[key] = value;
	}

	get annotation(): Record<string, unknown> {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return isRecord(schematic?.annotation) ? schematic.annotation : {};
	}

	setAnnotationValue(key: string, value: unknown): void {
		const schematic = this.ensureRecord('schematic');
		if (!isRecord(schematic.annotation)) schematic.annotation = {};
		(schematic.annotation as Record<string, unknown>)[key] = value;
	}

	get fieldNameTemplates(): FieldNameTemplateRecord[] {
		const fields = this.schematicDrawing.field_names;
		return Array.isArray(fields) ? fields as FieldNameTemplateRecord[] : [];
	}

	addFieldNameTemplate(): FieldNameTemplateRecord {
		const schematic = this.ensureRecord('schematic');
		if (!isRecord(schematic.drawing)) schematic.drawing = {};
		const drawing = schematic.drawing as Record<string, unknown>;
		if (!Array.isArray(drawing.field_names)) drawing.field_names = [];
		const field: FieldNameTemplateRecord = { name: 'Untitled Field', visible: false, url: false };
		(drawing.field_names as FieldNameTemplateRecord[]).push(field);
		return field;
	}

	get bomSettings(): BomPresetRecord {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return isRecord(schematic?.bom_settings) ? schematic.bom_settings as BomPresetRecord : clone(DEFAULT_BOM_SETTINGS);
	}

	get hasBomSettings(): boolean {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return isRecord(schematic?.bom_settings);
	}

	setBomSettings(settings: BomPresetRecord): void {
		this.ensureRecord('schematic').bom_settings = settings;
	}

	get bomPresets(): BomPresetRecord[] {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return Array.isArray(schematic?.bom_presets) ? schematic.bom_presets as BomPresetRecord[] : [];
	}

	get bomFormatSettings(): BomFormatPresetRecord {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return isRecord(schematic?.bom_fmt_settings)
			? schematic.bom_fmt_settings as BomFormatPresetRecord : clone(DEFAULT_BOM_FORMAT_SETTINGS);
	}

	get hasBomFormatSettings(): boolean {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return isRecord(schematic?.bom_fmt_settings);
	}

	setBomFormatSettings(settings: BomFormatPresetRecord): void {
		this.ensureRecord('schematic').bom_fmt_settings = settings;
	}

	get bomFormatPresets(): BomFormatPresetRecord[] {
		const schematic = isRecord(this.draft.schematic) ? this.draft.schematic : null;
		return Array.isArray(schematic?.bom_fmt_presets) ? schematic.bom_fmt_presets as BomFormatPresetRecord[] : [];
	}

	get ercRuleSeverities(): Record<string, string> {
		const erc = isRecord(this.draft.erc) ? this.draft.erc : null;
		if (!isRecord(erc?.rule_severities)) return {};
		return Object.fromEntries(Object.entries(erc.rule_severities).map(([key, value]) => [key, String(value)]));
	}

	setErcRuleSeverity(key: string, severity: string): void {
		const erc = this.ensureRecord('erc');
		if (!isRecord(erc.rule_severities)) erc.rule_severities = {};
		(erc.rule_severities as Record<string, unknown>)[key] = severity;
	}

	get pinMap(): number[][] {
		const erc = isRecord(this.draft.erc) ? this.draft.erc : null;
		if (Array.isArray(erc?.pin_map) && erc.pin_map.length === 12) return erc.pin_map as number[][];
		return DEFAULT_PIN_MAP.map(row => [...row]);
	}

	setPinMapValue(row: number, column: number, value: number): void {
		const erc = this.ensureRecord('erc');
		if (!Array.isArray(erc.pin_map) || erc.pin_map.length !== 12) {
			erc.pin_map = DEFAULT_PIN_MAP.map(item => [...item]);
		}
		const matrix = erc.pin_map as number[][];
		matrix[row]![column] = value;
		matrix[column]![row] = value;
	}

	resetPinMap(): void {
		this.ensureRecord('erc').pin_map = DEFAULT_PIN_MAP.map(row => [...row]);
	}

	get boardDesignSettings(): Record<string, unknown> {
		const board = isRecord(this.draft.board) ? this.draft.board : null;
		return isRecord(board?.design_settings) ? board.design_settings : {};
	}

	getBoardDesignValue(path: string, fallback: unknown): unknown {
		let current: unknown = this.boardDesignSettings;
		for (const key of path.split('.')) {
			if (!isRecord(current) || !(key in current)) return fallback;
			current = current[key];
		}
		return current;
	}

	setBoardDesignValue(path: string, value: unknown): void {
		let current = this.ensureBoardDesignSettings();
		const parts = path.split('.');
		for (const key of parts.slice(0, -1)) {
			if (!isRecord(current[key])) current[key] = {};
			current = current[key] as Record<string, unknown>;
		}
		current[parts.at(-1)!] = value;
	}

	get trackWidths(): number[] {
		const value = this.boardDesignSettings.track_widths;
		return Array.isArray(value) ? value.map(Number) : [];
	}

	get viaDimensions(): ViaDimensionRecord[] {
		const value = this.boardDesignSettings.via_dimensions;
		return Array.isArray(value) ? value as ViaDimensionRecord[] : [];
	}

	get diffPairDimensions(): DiffPairDimensionRecord[] {
		const value = this.boardDesignSettings.diff_pair_dimensions;
		return Array.isArray(value) ? value as DiffPairDimensionRecord[] : [];
	}

	get teardropOptions(): Record<string, unknown> {
		const value = this.boardDesignSettings.teardrop_options;
		return Array.isArray(value) && isRecord(value[0]) ? value[0] : {};
	}

	setTeardropOption(key: string, value: boolean): void {
		const current = { ...this.teardropOptions, [key]: value };
		this.setBoardDesignValue('teardrop_options', [current]);
	}

	get teardropParameters(): TeardropParameterRecord[] {
		const value = this.boardDesignSettings.teardrop_parameters;
		return Array.isArray(value) ? value as TeardropParameterRecord[] : [];
	}

	get tuningPatternSettings(): Record<string, Record<string, unknown>> {
		const value = this.boardDesignSettings.tuning_pattern_settings;
		return isRecord(value) ? value as Record<string, Record<string, unknown>> : {};
	}

	get drcRuleSeverities(): Record<string, string> {
		const value = this.boardDesignSettings.rule_severities;
		if (!isRecord(value)) return {};
		return Object.fromEntries(Object.entries(value).map(([key, severity]) => [key, String(severity)]));
	}

	setDrcRuleSeverity(key: string, severity: string): void {
		const current = { ...this.drcRuleSeverities, [key]: severity };
		this.setBoardDesignValue('rule_severities', current);
	}

	addTuningProfile(): TuningProfileRecord {
		const settings = this.ensureRecord('tuning_profiles');
		if (!Array.isArray(settings.tuning_profiles_impedance_geometric)) settings.tuning_profiles_impedance_geometric = [];
		const profile: TuningProfileRecord = {
			profile_name: `Profile ${ this.tuningProfiles.length + 1 }`, type: 0, target_impedance: 50,
			frequency: 1e9, model_solder_mask: false, enable_time_domain_tuning: false,
			layer_entries: [], via_prop_delay: 0, via_overrides: []
		};
		(settings.tuning_profiles_impedance_geometric as TuningProfileRecord[]).push(profile);
		return profile;
	}

	addNetClass(): NetClassRecord {
		const settings = this.ensureNetSettings();
		if (!Array.isArray(settings.classes)) settings.classes = [];
		const classes = settings.classes as NetClassRecord[];
		const used = new Set(classes.map(item => item.name));
		let suffix = 1;
		while (used.has(`NetClass${ suffix }`)) suffix++;
		const next = clone(DEFAULT_NET_CLASS);
		next.name = `NetClass${ suffix }`;
		next.priority = classes.filter(item => item.name !== 'Default').length;
		classes.push(next);
		return next;
	}

	removeNetClass(index: number): boolean {
		const target = this.netClasses[index];
		if (!target || target.name === 'Default') return false;
		this.netClasses.splice(index, 1);
		return true;
	}

	/** Restores a net class's routing/formatting fields to real KiCad's own
	 *  stock values — `name` and `priority` are left untouched so this can't
	 *  rename a class or disturb its position in the priority order. Exists
	 *  for projects created before createBlank() seeded the Default class
	 *  with real values (it used to write just `{ name: 'Default' }`,
	 *  leaving every numeric field undefined and failing
	 *  validateNetClasses()'s non-negative check) — this is the in-app fix
	 *  for a project stuck in that state, no re-creation needed. */
	resetNetClassToDefaults(index: number): NetClassRecord | null {
		const target = this.netClasses[index];
		if (!target) return null;
		const defaults = clone(DEFAULT_NET_CLASS);
		for (const key of Object.keys(defaults) as (keyof NetClassRecord)[]) {
			if (key === 'name' || key === 'priority') continue;
			(target as Record<string, unknown>)[key] = defaults[key];
		}
		return target;
	}

	get boardLayers(): KicadLayerDefinition[] {
		return this.getBoardLayersElement()?.layers ?? [];
	}

	setBoardLayerAlias(index: number, alias: string): void {
		const layer = this.boardLayers[index];
		if (!layer) return;
		if (alias.trim()) layer.alias = alias.trim();
		else delete layer.alias;
	}

	setBoardLayerType(index: number, type: KicadLayerType): void {
		const layer = this.boardLayers[index];
		if (layer) layer.type = type;
	}

	get copperLayerCount(): number {
		return this.boardLayers.filter(layer => this.isCopperLayerId(layer.id)).length;
	}

	setCopperLayerCount(count: number): void {
		if (!Number.isInteger(count) || count < 2 || count > 32 || count % 2 !== 0) {
			throw new Error('Copper layer count must be an even number between 2 and 32.');
		}
		const layers = this.getBoardLayersElement();
		if (!layers) throw new Error('The board has no layer table.');
		const desiredIds = new Set([0, ...Array.from({ length: count - 2 }, (_, index) => 4 + index * 2), 2]);
		const removed = layers.layers.filter(layer => this.isCopperLayerId(layer.id) && !desiredIds.has(layer.id));
		const used = this.usedBoardLayerNames();
		const usedRemoved = removed.filter(layer => used.has(layer.name) || (layer.alias && used.has(layer.alias)));
		if (usedRemoved.length) {
			throw new Error(`Cannot remove ${ usedRemoved.map(layer => layer.name).join(', ') }: board items still use those layers.`);
		}
		const oldById = new Map(layers.layers.map(layer => [layer.id, layer]));
		const copper: KicadLayerDefinition[] = [
			oldById.get(0) ?? { id: 0, name: 'F.Cu', type: 'signal' },
			...Array.from({ length: count - 2 }, (_, index) => {
				const id = 4 + index * 2;
				return oldById.get(id) ?? { id, name: `In${ index + 1 }.Cu`, type: 'signal' as KicadLayerType };
			}),
			oldById.get(2) ?? { id: 2, name: 'B.Cu', type: 'signal' }
		];
		const nonCopper = layers.layers.filter(layer => !this.isCopperLayerId(layer.id));
		layers.layers.splice(0, layers.layers.length, ...copper, ...nonCopper);
		this.rebuildCopperStackup(copper.map(layer => layer.name));
	}

	get stackupLayers(): StackupLayerRecord[] {
		return (this.getStackup()?.getLayers() ?? []).map((layer, index) => ({
			index,
			name: layer.getLayerName(),
			type: layer.getStackupType() ?? '',
			thickness: layer.getThickness(),
			material: layer.getMaterial(),
			color: layer.getStackupColor(),
			epsilonR: layer.getEpsilonR(),
			lossTangent: layer.getLossTangent(),
			lockThickness: layer.getThicknessLocked()
		}));
	}

	updateStackupLayer(index: number, patch: Partial<Omit<StackupLayerRecord, 'index' | 'name'>>): void {
		const layer = this.getStackup()?.getLayers()[index];
		if (!layer) return;
		if (patch.type !== undefined) layer.setStackupType(patch.type);
		if (patch.thickness !== undefined) layer.setThickness(patch.thickness);
		if (patch.material !== undefined) layer.setMaterial(patch.material);
		if (patch.color !== undefined) layer.setStackupColor(patch.color);
		if (patch.epsilonR !== undefined) layer.setEpsilonR(patch.epsilonR);
		if (patch.lossTangent !== undefined) layer.setLossTangent(patch.lossTangent);
		if (patch.lockThickness !== undefined) layer.setThicknessLocked(patch.lockThickness);
	}

	/**
	 * Inserts a new dielectric row right after the stackup row at `afterIndex`
	 * (use -1 to insert before the first row), with KiCad-consistent defaults
	 * for a core layer. Dielectric rows are renumbered afterwards so their
	 * `dielectric N` names stay sequential, matching rebuildCopperStackup's
	 * naming convention.
	 */
	insertDielectricLayer(afterIndex: number): void {
		const stackup = this.getOrCreateStackup();
		const layerCount = stackup.getLayers().length;
		const insertPos = Math.min(Math.max(afterIndex + 1, 0), layerCount);
		const newLayer = stackup.insertLayer(insertPos, 'dielectric');
		newLayer.setStackupType('core').setThickness(1.51).setMaterial('FR4')
			.setStackupColor('FR4 natural').setEpsilonR(4.5).setLossTangent(0.02);
		this.renumberDielectricLayers();
		this.setBoardThickness(this.stackupThickness);
	}

	/** Removes the dielectric row at the given stackup index. */
	removeDielectricLayer(index: number): void {
		const stackup = this.getStackup();
		if (!stackup) return;
		stackup.removeLayerAt(index);
		this.renumberDielectricLayers();
		this.setBoardThickness(this.stackupThickness);
	}

	protected renumberDielectricLayers(): void {
		const stackup = this.getStackup();
		if (!stackup) return;
		let n = 1;
		for (const layer of stackup.getLayers()) {
			if (/^dielectric(\s+\d+)?$/i.test(layer.getLayerName())) {
				layer.setAttribute({ value: `dielectric ${ n }`, format: 'quoted' }, 0);
				n++;
			}
		}
	}

	get stackupThickness(): number {
		return this.stackupLayers.reduce((sum, layer) => sum + (layer.thickness ?? 0), 0);
	}

	get boardThickness(): number {
		return this.getGeneral()?.findFirstChildByClass(KicadElementThickness)?.value ?? 0;
	}

	setBoardThickness(value: number): void {
		this.getOrCreateGeneral().findOrCreateChildByClass(KicadElementThickness).value = value;
	}

	getBoardFinishValue(name: string, fallback: string | boolean): string | boolean {
		const value = this.getStackup()?.getSimpleChildValue(name);
		return typeof value === 'string' || typeof value === 'boolean' ? value : fallback;
	}

	setBoardFinishValue(name: string, value: string | boolean): void {
		const stackup = this.getOrCreateStackup();
		if ((name === 'copper_finish' && value === 'None') || (name === 'edge_connector' && value === 'none') || (name === 'edge_plating' && value === false)) {
			const index = stackup.children.findIndex(child => child.name === name);
			if (index >= 0) stackup.children.splice(index, 1);
			return;
		}
		const format = typeof value === 'boolean' ? 'boolean' : name === 'edge_connector' ? 'literal' : 'quoted';
		stackup.setSimpleChild(name, value, format);
	}

	getBoardSetupNumber(name: string, fallback = 0): number {
		return Number(this.getSetup()?.getSimpleChildValue(name) ?? fallback);
	}

	setBoardSetupNumber(name: string, value: number): void {
		this.getOrCreateSetup().setSimpleChild(name, value, 'numeric');
	}

	getBoardSetupBoolean(name: string, fallback = false): boolean {
		return Boolean(this.getSetup()?.getSimpleChildValue(name) ?? fallback);
	}

	setBoardSetupBoolean(name: string, value: boolean): void {
		this.getOrCreateSetup().setSimpleChild(name, value, 'boolean');
	}

	getBoardSetupSides(name: 'tenting' | 'covering' | 'plugging'): { front: boolean; back: boolean } {
		const values = this.getSetup()?.findFirstChildByName(name)?.attributes.map(attribute => String(attribute.value)) ?? [];
		return { front: values.includes('front'), back: values.includes('back') };
	}

	setBoardSetupSides(name: 'tenting' | 'covering' | 'plugging', front: boolean, back: boolean): void {
		const node = this.getOrCreateSetup().findOrCreateChildByName(name);
		node.attributes.splice(0, node.attributes.length);
		if (front) node.setAttribute({ value: 'front', format: 'literal' });
		if (back) node.setAttribute({ value: 'back', format: 'literal' });
	}

	get boardEmbeddedFiles(): KicadElementEmbeddedFile[] {
		return this.draftBoardRoot?.findFirstChildByClass(KicadElementEmbeddedFiles)?.files ?? [];
	}

	/** Compresses `bytes` (Raw_Block — no LZ/entropy coding, see encodeRaw.ts's
	 *  header comment) and computes its KiCad MMH3 checksum over the
	 *  UNCOMPRESSED content, matching what pcbnew's own EMBEDDED_FILES writer
	 *  stores — callers only ever need to hand over the plain file bytes. */
	addBoardEmbeddedFile(name: string, type: string, bytes: Uint8Array): KicadElementEmbeddedFile {
		if (!this.draftBoardRoot) throw new Error('This project has no board file.');
		const container = this.draftBoardRoot.findOrCreateChildByClass(KicadElementEmbeddedFiles);
		return container.addFile(name, type, encodeRawFrame(bytes), mmh3Hash128Hex(bytes));
	}

	removeBoardEmbeddedFile(name: string): boolean {
		return this.draftBoardRoot?.findFirstChildByClass(KicadElementEmbeddedFiles)?.removeFile(name) ?? false;
	}

	get schematicEmbeddedFiles(): KicadElementEmbeddedFile[] {
		return this.draftSchematicRoot?.findFirstChildByClass(KicadElementEmbeddedFiles)?.files ?? [];
	}

	addSchematicEmbeddedFile(name: string, type: string, bytes: Uint8Array): KicadElementEmbeddedFile {
		if (!this.draftSchematicRoot) throw new Error('This project has no schematic file.');
		const container = this.draftSchematicRoot.findOrCreateChildByClass(KicadElementEmbeddedFiles);
		return container.addFile(name, type, encodeRawFrame(bytes), mmh3Hash128Hex(bytes));
	}

	removeSchematicEmbeddedFile(name: string): boolean {
		return this.draftSchematicRoot?.findFirstChildByClass(KicadElementEmbeddedFiles)?.removeFile(name) ?? false;
	}

	reset(): void {
		this.draft = clone(this.original);
		this.draftBoardRoot = this.originalBoardText ? this.parseBoard(this.originalBoardText) : null;
		this.draftSchematicRoot = this.originalSchematicText ? this.parseBoard(this.originalSchematicText) : null;
		this.draftRulesText = this.originalRulesText;
	}

	validate(): ValidationIssue[] {
		return [
			...this.validateTextVariables(),
			...this.validateNetClasses(),
			...this.validateProjectCollections(),
			...this.validateSchematicSettings(),
			...this.validateBoardDesignSettings(),
			...this.validateBoardFileSettings()
		];
	}

	async apply(
		projectFile: KicadProjectFile, board?: KicadBoard, designRules?: KicadDesignRulesFile,
		schematic?: KicadSchematic
	): Promise<void> {
		this.prepareSchemaVersions();
		const issues = this.validate();
		if (issues.length) {
			throw new Error(issues[0]!.message);
		}
		if (stableJson(projectFile.raw) !== this.originalJson) {
			throw new Error('Project settings changed outside this tab. Revert and review the newer project data before applying.');
		}
		if (this.originalBoardText && board?.rootElement?.write() !== this.originalBoardText) {
			throw new Error('Board settings changed outside this tab. Revert and review the newer board data before applying.');
		}
		if (this.originalSchematicText && schematic?.rootElement?.write() !== this.originalSchematicText) {
			throw new Error('Schematic settings changed outside this tab. Revert and review the newer schematic data before applying.');
		}
		if (this.originalRulesText !== null && designRules?.data !== this.originalRulesText) {
			throw new Error('Custom rules changed outside this tab. Revert and review the newer rules text before applying.');
		}
		const previous = projectFile.raw;
		const next = clone(this.draft) as Record<string, any>;
		const projectChanged = stableJson(next) !== this.originalJson;
		const boardChanged = this.isBoardDirty;
		const schematicChanged = this.isSchematicDirty;
		const rulesChanged = this.isRulesDirty;
		const nextBoardText = this.draftBoardRoot?.write() ?? null;
		const nextSchematicText = this.draftSchematicRoot?.write() ?? null;
		if (boardChanged && (!board || !board.saveFile || !nextBoardText)) {
			throw new Error('The board file cannot be saved by this project adapter.');
		}
		if (schematicChanged && (!schematic || !schematic.saveFile || !nextSchematicText)) {
			throw new Error('The schematic file cannot be saved by this project adapter.');
		}
		if (rulesChanged && (!designRules || !designRules.saveFile)) {
			throw new Error('The custom rules file cannot be saved by this project adapter.');
		}
		try {
			if (rulesChanged) await designRules!.saveFile!(designRules!.path, this.draftRulesText ?? '');
			if (boardChanged) await board!.saveFile!(board!.path, nextBoardText! + '\n');
			if (schematicChanged) await schematic!.saveFile!(schematic!.path, nextSchematicText! + '\n');
			if (projectChanged) {
				projectFile.raw = next;
				await projectFile.save();
			}
		}
		catch (error) {
			projectFile.raw = previous;
			if (boardChanged && board?.saveFile && this.originalBoardText) {
				try { await board.saveFile(board.path, this.originalBoardText + '\n'); }
				catch { /* Best-effort rollback; retain the original in-memory board. */ }
			}
			if (schematicChanged && schematic?.saveFile && this.originalSchematicText) {
				try { await schematic.saveFile(schematic.path, this.originalSchematicText + '\n'); }
				catch { /* Best-effort rollback; retain the original in-memory schematic. */ }
			}
			if (rulesChanged && designRules?.saveFile && this.originalRulesText !== null) {
				try { await designRules.saveFile(designRules.path, this.originalRulesText); }
				catch { /* Best-effort rollback; retain the original in-memory rules text. */ }
			}
			throw error;
		}
		if (boardChanged && board && nextBoardText) {
			board.rootElement = this.parseBoard(nextBoardText);
			board.data = nextBoardText + '\n';
			this.originalBoardText = nextBoardText;
			this.draftBoardRoot = this.parseBoard(nextBoardText);
		}
		if (schematicChanged && schematic && nextSchematicText) {
			schematic.rootElement = this.parseBoard(nextSchematicText);
			schematic.data = nextSchematicText + '\n';
			this.originalSchematicText = nextSchematicText;
			this.draftSchematicRoot = this.parseBoard(nextSchematicText);
		}
		if (rulesChanged && designRules) {
			designRules.data = this.draftRulesText ?? '';
			designRules.loaded = true;
			this.originalRulesText = this.draftRulesText;
		}
		this.original = clone(next);
		this.originalJson = stableJson(next);
		this.draft = clone(next);
	}

	protected parseBoard(text: string): KicadElement {
		return new KicadParser().parse(text);
	}

	protected getBoardLayersElement(): KicadElementLayers | undefined {
		return this.draftBoardRoot?.findFirstChildByClass(KicadElementLayers);
	}

	protected getGeneral(): KicadElement | undefined {
		return this.draftBoardRoot?.findFirstChildByName('general');
	}

	protected getOrCreateGeneral(): KicadElement {
		if (!this.draftBoardRoot) throw new Error('This project has no board file.');
		return this.draftBoardRoot.findOrCreateChildByName('general');
	}

	protected getSetup(): KicadElementSetup | undefined {
		return this.draftBoardRoot?.findFirstChildByClass(KicadElementSetup);
	}

	protected getOrCreateSetup(): KicadElementSetup {
		if (!this.draftBoardRoot) throw new Error('This project has no board file.');
		return this.draftBoardRoot.findOrCreateChildByClass(KicadElementSetup);
	}

	protected getStackup(): KicadElementStackup | undefined {
		return this.getSetup()?.getStackup();
	}

	protected getOrCreateStackup(): KicadElementStackup {
		return this.getOrCreateSetup().getOrCreateStackup();
	}

	protected isCopperLayerId(id: number): boolean {
		return id === 0 || id === 2 || (id >= 4 && id <= 62 && id % 2 === 0);
	}

	protected usedBoardLayerNames(): Set<string> {
		const used = new Set<string>();
		if (!this.draftBoardRoot) return used;
		for (const node of this.draftBoardRoot.findAllChildrenByName('layer')) {
			if (node.parent?.name === 'stackup') continue;
			const value = node.attributes[0]?.value;
			if (typeof value === 'string') used.add(value);
		}
		for (const node of this.draftBoardRoot.findAllChildrenByName('layers')) {
			if (node === this.getBoardLayersElement()) continue;
			for (const attribute of node.attributes) {
				if (typeof attribute.value === 'string' && !attribute.value.includes('*')) used.add(attribute.value);
			}
		}
		return used;
	}

	protected rebuildCopperStackup(copperNames: string[]): void {
		const stackup = this.getOrCreateStackup();
		const layerNodes = stackup.getLayers();
		const frontIndex = layerNodes.findIndex(layer => layer.getLayerName() === 'F.Cu');
		const backIndex = layerNodes.findIndex(layer => layer.getLayerName() === 'B.Cu');
		const prefix = frontIndex >= 0 ? layerNodes.slice(0, frontIndex) : [];
		const suffix = backIndex >= 0 ? layerNodes.slice(backIndex + 1) : [];
		const existingCopper = new Map(layerNodes
			.filter(layer => /^(F|B|In\d+)\.Cu$/.test(layer.getLayerName()))
			.map(layer => [layer.getLayerName(), layer]));
		const existingDielectrics = layerNodes.filter(layer => /^dielectric\s+\d+$/i.test(layer.getLayerName()));
		const core: KicadElementLayer[] = [];
		copperNames.forEach((name, index) => {
			const copper = existingCopper.get(name) ?? new KicadElementLayer(name).setStackupType('copper').setThickness(index === 0 || index === copperNames.length - 1 ? 0.035 : 0.018);
			core.push(copper);
			if (index >= copperNames.length - 1) return;
			const dielectric = existingDielectrics[index] ?? new KicadElementLayer(`dielectric ${ index + 1 }`)
				.setStackupType(index % 2 ? 'core' : 'prepreg').setThickness(0.1).setMaterial('FR4').setStackupColor('FR4 natural').setEpsilonR(4.5).setLossTangent(0.02);
			dielectric.setAttribute({ value: `dielectric ${ index + 1 }`, format: 'quoted' }, 0);
			core.push(dielectric);
		});
		const nonLayers = stackup.children.filter(child => !(child instanceof KicadElementLayer));
		stackup.children.splice(0, stackup.children.length);
		for (const layer of [...prefix, ...core, ...suffix]) stackup.addChild(layer);
		for (const node of nonLayers) stackup.addChild(node);
		this.setBoardThickness(this.stackupThickness);
	}

	protected ensureNetSettings(): Record<string, unknown> {
		if (!isRecord(this.draft.net_settings)) {
			this.draft.net_settings = {
				classes: [clone(DEFAULT_NET_CLASS)],
				meta: { version: 5 },
				net_colors: null,
				netclass_assignments: null,
				netclass_patterns: []
			};
		}
		return this.draft.net_settings as Record<string, unknown>;
	}

	protected ensureRecord(key: string): Record<string, unknown> {
		if (!isRecord(this.draft[key])) this.draft[key] = {};
		return this.draft[key] as Record<string, unknown>;
	}

	protected ensureBoardDesignSettings(): Record<string, unknown> {
		const board = this.ensureRecord('board');
		if (!isRecord(board.design_settings)) board.design_settings = {};
		return board.design_settings as Record<string, unknown>;
	}

	protected prepareSchemaVersions(): void {
		const setVersionWhenChanged = (key: string, version: number): void => {
			if (stableJson(this.draft[key]) === stableJson(this.original[key])) return;
			const owner = this.ensureRecord(key);
			const meta = isRecord(owner.meta) ? owner.meta : {};
			meta.version = version;
			owner.meta = meta;
		};
		setVersionWhenChanged('net_settings', 5);
		setVersionWhenChanged('component_class_settings', 0);
		setVersionWhenChanged('tuning_profiles', 1);
		setVersionWhenChanged('schematic', 1);
		setVersionWhenChanged('erc', 0);
		if (stableJson(this.draft.board) !== stableJson(this.original.board)) {
			const settings = this.ensureBoardDesignSettings();
			const meta = isRecord(settings.meta) ? settings.meta : {};
			meta.version = 2;
			settings.meta = meta;
		}
	}

	protected validateTextVariables(): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		for (const [name, value] of Object.entries(this.textVariables)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				issues.push({ path: `text_variables.${ name }`, message: `Text variable “${ name }” must be a KiCad identifier (letters, digits, and underscores; not starting with a digit).` });
			}
			if (typeof value !== 'string') {
				issues.push({ path: `text_variables.${ name }`, message: `Text variable “${ name }” must contain text.` });
			}
		}
		return issues;
	}

	protected validateNetClasses(): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const names = new Set<string>();
		let defaultCount = 0;
		const nonNegativeFields = [
			'clearance', 'track_width', 'via_diameter', 'via_drill',
			'microvia_diameter', 'microvia_drill', 'diff_pair_width',
			'diff_pair_gap', 'diff_pair_via_gap', 'wire_width', 'bus_width'
		] as const;
		this.netClasses.forEach((item, index) => {
			const name = String(item.name ?? '').trim();
			if (!name) issues.push({ path: `net_settings.classes.${ index }.name`, message: 'Every net class needs a name.' });
			if (names.has(name)) issues.push({ path: `net_settings.classes.${ index }.name`, message: `Net class name “${ name }” is duplicated.` });
			names.add(name);
			if (name === 'Default') defaultCount++;
			for (const field of nonNegativeFields) {
				const value = item[field];
				if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
					issues.push({ path: `net_settings.classes.${ index }.${ field }`, message: `${ name || 'Net class' }: ${ field.replaceAll('_', ' ') } must be a non-negative number.` });
				}
			}
			if (Number(item.via_drill) >= Number(item.via_diameter)) {
				issues.push({ path: `net_settings.classes.${ index }.via_drill`, message: `${ name }: via drill must be smaller than via diameter.` });
			}
			if (Number(item.microvia_drill) >= Number(item.microvia_diameter)) {
				issues.push({ path: `net_settings.classes.${ index }.microvia_drill`, message: `${ name }: microvia drill must be smaller than microvia diameter.` });
			}
		});
		if (defaultCount !== 1) {
			issues.push({ path: 'net_settings.classes', message: 'The project must contain exactly one net class named “Default”.' });
		}
		this.netClassPatterns.forEach((row, index) => {
			if (!String(row.pattern ?? '').trim()) issues.push({ path: `net_settings.netclass_patterns.${ index }.pattern`, message: 'Net class patterns cannot be empty.' });
			if (!names.has(String(row.netclass ?? ''))) issues.push({ path: `net_settings.netclass_patterns.${ index }.netclass`, message: `Pattern “${ row.pattern }” references a missing net class.` });
		});
		for (const [net, netclasses] of Object.entries(this.netClassAssignments)) {
			if (!net.trim()) issues.push({ path: 'net_settings.netclass_assignments', message: 'Direct net assignments cannot have an empty net name.' });
			for (const netclass of netclasses) {
				if (!names.has(netclass)) issues.push({ path: `net_settings.netclass_assignments.${ net }`, message: `Net “${ net }” references missing net class “${ netclass }”.` });
			}
		}
		return issues;
	}

	protected validateProjectCollections(): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const unique = (values: string[], path: string, label: string): void => {
			const seen = new Set<string>();
			for (const value of values) {
				if (!value.trim()) issues.push({ path, message: `${ label } cannot be empty.` });
				else if (seen.has(value)) issues.push({ path, message: `${ label } “${ value }” is duplicated.` });
				seen.add(value);
			}
		};
		unique(Object.keys(this.busAliases), 'schematic.bus_aliases', 'Bus alias');
		for (const [name, members] of Object.entries(this.busAliases)) {
			if (!members.length || members.some(member => !member.trim())) issues.push({ path: `schematic.bus_aliases.${ name }`, message: `Bus alias “${ name }” needs at least one non-empty member.` });
		}
		unique(this.pinnedSymbolLibraries, 'libraries.pinned_symbol_libs', 'Pinned symbol library');
		unique(this.pinnedFootprintLibraries, 'libraries.pinned_footprint_libs', 'Pinned footprint library');
		unique(Object.keys(this.netChainClasses), 'net_settings.net_chain_classes', 'Net chain');
		const classNames = new Set(this.netClasses.map(item => item.name));
		for (const [chain, className] of Object.entries(this.netChainClasses)) {
			if (!classNames.has(className)) issues.push({ path: `net_settings.net_chain_classes.${ chain }`, message: `Net chain “${ chain }” references missing net class “${ className }”.` });
		}
		this.componentClassAssignments.forEach((assignment, index) => {
			if (!String(assignment.component_class ?? '').trim()) issues.push({ path: `component_class_settings.assignments.${ index }`, message: 'Every component-class assignment needs a component class name.' });
			if (assignment.conditions_operator !== 'ALL' && assignment.conditions_operator !== 'ANY') issues.push({ path: `component_class_settings.assignments.${ index }.conditions_operator`, message: 'Component-class condition operator must be ALL or ANY.' });
		});
		unique(this.tuningProfiles.map(profile => profile.profile_name), 'tuning_profiles', 'Tuning profile');
		const profileNames = new Set(this.tuningProfiles.map(profile => profile.profile_name));
		for (const netClass of this.netClasses) {
			const profile = String(netClass.tuning_profile ?? '');
			if (profile && !profileNames.has(profile)) issues.push({ path: 'net_settings.classes.tuning_profile', message: `Net class “${ netClass.name }” references missing tuning profile “${ profile }”.` });
		}
		for (const profile of this.tuningProfiles) {
			if (!Number.isFinite(profile.target_impedance) || profile.target_impedance <= 0) issues.push({ path: 'tuning_profiles.target_impedance', message: `${ profile.profile_name || 'Tuning profile' }: target impedance must be positive.` });
			if (!Number.isFinite(profile.frequency) || profile.frequency <= 0) issues.push({ path: 'tuning_profiles.frequency', message: `${ profile.profile_name || 'Tuning profile' }: frequency must be positive.` });
		}
		return issues;
	}

	protected validateSchematicSettings(): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const numeric = (value: unknown, path: string, label: string, min = 0, max = Number.POSITIVE_INFINITY): void => {
			if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
				issues.push({ path, message: `${ label } must be between ${ min } and ${ max === Number.POSITIVE_INFINITY ? 'a valid upper value' : max }.` });
			}
		};
		const drawing = this.schematicDrawing;
		for (const [key, label, min, max] of [
			['default_line_thickness', 'Default line thickness', 5, 1000],
			['default_text_size', 'Default text size', 5, 1000],
			['pin_symbol_size', 'Pin symbol size', 0, 1000],
			['text_offset_ratio', 'Text offset ratio', 0, 2],
			['label_size_ratio', 'Label size ratio', 0, 2],
			['overbar_offset_ratio', 'Overbar offset ratio', 0, 5],
			['dashed_lines_dash_length_ratio', 'Dash length ratio', 0, 100],
			['dashed_lines_gap_length_ratio', 'Dash gap ratio', 0, 100]
		] as const) {
			if (key in drawing) numeric(drawing[key], `schematic.drawing.${ key }`, label, min, max);
		}
		const connectionGrid = this.getSchematicValue('connection_grid_size', 50);
		numeric(connectionGrid, 'schematic.connection_grid_size', 'Connection grid size', 1, 10000);
		const method = Number(this.annotation.method ?? 0);
		const sortOrder = Number(this.annotation.sort_order ?? 0);
		if (![0, 1, 2].includes(method)) issues.push({ path: 'schematic.annotation.method', message: 'Annotation numbering method must be 0, 1, or 2.' });
		if (![0, 1].includes(sortOrder)) issues.push({ path: 'schematic.annotation.sort_order', message: 'Annotation sort order must be X or Y.' });
		const fieldNames = new Set<string>();
		this.fieldNameTemplates.forEach((field, index) => {
			if (!String(field.name ?? '').trim()) issues.push({ path: `schematic.drawing.field_names.${ index }`, message: 'Field name templates cannot be empty.' });
			else if (fieldNames.has(field.name)) issues.push({ path: `schematic.drawing.field_names.${ index }`, message: `Field name template “${ field.name }” is duplicated.` });
			fieldNames.add(field.name);
		});
		const presetNames = new Set<string>();
		this.bomPresets.forEach((preset, index) => {
			if (!String(preset.name ?? '').trim()) issues.push({ path: `schematic.bom_presets.${ index }`, message: 'Every BOM preset needs a name.' });
			else if (presetNames.has(preset.name)) issues.push({ path: `schematic.bom_presets.${ index }`, message: `BOM preset “${ preset.name }” is duplicated.` });
			presetNames.add(preset.name);
		});
		const formatNames = new Set<string>();
		this.bomFormatPresets.forEach((preset, index) => {
			if (!String(preset.name ?? '').trim()) issues.push({ path: `schematic.bom_fmt_presets.${ index }`, message: 'Every BOM format preset needs a name.' });
			else if (formatNames.has(preset.name)) issues.push({ path: `schematic.bom_fmt_presets.${ index }`, message: `BOM format preset “${ preset.name }” is duplicated.` });
			formatNames.add(preset.name);
		});
		const pinMap = this.pinMap;
		if (pinMap.length !== 12 || pinMap.some(row => !Array.isArray(row) || row.length !== 12 || row.some(value => ![0, 1, 2].includes(value)))) {
			issues.push({ path: 'erc.pin_map', message: 'The ERC pin-conflict map must be a 12 × 12 matrix of OK, warning, or error values.' });
		}
		return issues;
	}

	protected validateBoardDesignSettings(): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const check = (path: string, label: string, min: number, max: number): void => {
			const value = this.getBoardDesignValue(path, undefined);
			if (value === undefined) return;
			if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
				issues.push({ path: `board.design_settings.${ path }`, message: `${ label } must be between ${ min } and ${ max }.` });
			}
		};
		for (const [key, label, min, max] of [
			['rules.min_clearance', 'Minimum clearance', 0, 25],
			['rules.min_connection', 'Minimum connection width', 0, 100],
			['rules.min_track_width', 'Minimum track width', 0, 25],
			['rules.min_via_annular_width', 'Minimum via annular width', 0, 25],
			['rules.min_via_diameter', 'Minimum via diameter', 0, 25],
			['rules.min_through_hole_diameter', 'Minimum through-hole drill', 0, 25],
			['rules.min_microvia_diameter', 'Minimum microvia diameter', 0, 10],
			['rules.min_microvia_drill', 'Minimum microvia drill', 0, 10],
			['rules.min_hole_to_hole', 'Minimum hole-to-hole clearance', 0, 10],
			['rules.min_hole_clearance', 'Minimum hole clearance', 0, 100],
			['rules.min_silk_clearance', 'Minimum silkscreen clearance', -10, 100],
			['rules.min_groove_width', 'Minimum groove width', 0, 25],
			['rules.min_resolved_spokes', 'Minimum resolved spokes', 0, 99],
			['rules.min_text_height', 'Minimum text height', 0, 100],
			['rules.min_text_thickness', 'Minimum text thickness', 0, 25],
			['rules.min_copper_edge_clearance', 'Copper-to-edge clearance', -0.01, 25],
			['rules.max_error', 'Maximum geometric error', 0.0001, 1],
			['rules.solder_mask_to_copper_clearance', 'Solder mask to copper clearance', 0, 25]
		] as const) check(key, label, min, max);
		for (const [key, label, min, max] of [
			['defaults.silk_line_width', 'Silkscreen line width', 0, 25],
			['defaults.copper_line_width', 'Copper line width', 0, 25],
			['defaults.fab_line_width', 'Fabrication line width', 0, 25],
			['defaults.other_line_width', 'Other line width', 0, 25],
			['defaults.board_outline_line_width', 'Board outline line width', 0, 25],
			['defaults.courtyard_line_width', 'Courtyard line width', 0, 25],
			['defaults.zones.min_clearance', 'Zone minimum clearance', 0, 25],
			['defaults.zones.min_thickness', 'Zone minimum thickness', 0, 25],
			['defaults.zones.hatch_thickness', 'Zone hatch thickness', 0, 25],
			['defaults.zones.hatch_gap', 'Zone hatch gap', 0, 25],
			['defaults.zones.hatch_smoothing_value', 'Zone hatch smoothing', 0, 1],
			['defaults.zones.border_hatch_pitch', 'Zone border hatch pitch', 0, 25],
			['defaults.zones.thermal_relief_gap', 'Zone thermal gap', 0, 25],
			['defaults.zones.thermal_relief_spoke_width', 'Zone thermal spoke width', 0, 25],
			['defaults.zones.corner_radius', 'Zone corner radius', 0, 25],
			['defaults.zones.min_island_area', 'Zone minimum island area', 0, Number.MAX_SAFE_INTEGER]
		] as const) check(key, label, min, max);
		const padWidth = this.getBoardDesignValue('defaults.pads.width', undefined);
		const padHeight = this.getBoardDesignValue('defaults.pads.height', undefined);
		const padDrill = this.getBoardDesignValue('defaults.pads.drill', undefined);
		if ([padWidth, padHeight, padDrill].some(value => value !== undefined)) {
			if (![padWidth, padHeight, padDrill].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
				issues.push({ path: 'board.design_settings.defaults.pads', message: 'Default pad width, height, and drill must be non-negative numbers.' });
			}
			else if ((padDrill as number) >= Math.min(padWidth as number, padHeight as number)) {
				issues.push({ path: 'board.design_settings.defaults.pads.drill', message: 'Default pad drill must be smaller than both pad dimensions.' });
			}
		}
		this.trackWidths.forEach((width, index) => {
			if (!Number.isFinite(width) || width < 0) issues.push({ path: `board.design_settings.track_widths.${ index }`, message: 'Track widths must be non-negative numbers.' });
		});
		this.viaDimensions.forEach((via, index) => {
			if (![via.diameter, via.drill].every(value => Number.isFinite(value) && value >= 0)) issues.push({ path: `board.design_settings.via_dimensions.${ index }`, message: 'Via diameter and drill must be non-negative numbers.' });
			if (via.diameter > 0 && via.drill >= via.diameter) issues.push({ path: `board.design_settings.via_dimensions.${ index }`, message: `Via preset ${ index + 1 }: drill must be smaller than diameter.` });
		});
		this.diffPairDimensions.forEach((pair, index) => {
			if (![pair.width, pair.gap, pair.via_gap].every(value => Number.isFinite(value) && value >= 0)) issues.push({ path: `board.design_settings.diff_pair_dimensions.${ index }`, message: 'Differential-pair dimensions must be non-negative numbers.' });
			if (index > 0 && pair.width > 0 && pair.gap <= 0) issues.push({ path: `board.design_settings.diff_pair_dimensions.${ index }.gap`, message: `Differential-pair preset ${ index + 1 } needs a gap.` });
		});
		for (const parameter of this.teardropParameters) {
			for (const key of ['td_length_ratio', 'td_height_ratio', 'td_width_to_size_filter_ratio'] as const) {
				const value = parameter[key];
				if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) issues.push({ path: `board.design_settings.teardrop_parameters.${ parameter.td_target_name }.${ key }`, message: `${ parameter.td_target_name }: ${ key.replaceAll('_', ' ') } must be between 0 and 1.` });
			}
			if ((parameter.td_maxlen !== undefined && parameter.td_maxlen < 0) || (parameter.td_maxheight !== undefined && parameter.td_maxheight < 0)) issues.push({ path: `board.design_settings.teardrop_parameters.${ parameter.td_target_name }`, message: `${ parameter.td_target_name }: maximum length and width must be non-negative.` });
		}
		for (const [name, settings] of Object.entries(this.tuningPatternSettings)) {
			const hasMin = settings.min_amplitude !== undefined;
			const hasMax = settings.max_amplitude !== undefined;
			const min = hasMin ? Number(settings.min_amplitude) : 0;
			const max = hasMax ? Number(settings.max_amplitude) : min;
			if ((hasMin && (!Number.isFinite(min) || min < 0)) || (hasMax && (!Number.isFinite(max) || max < 0)) || (hasMin && hasMax && max < min)) issues.push({ path: `board.design_settings.tuning_pattern_settings.${ name }`, message: `${ name.replaceAll('_', ' ') }: maximum amplitude must be at least the non-negative minimum.` });
			if (settings.corner_radius_percentage !== undefined) {
				const radius = Number(settings.corner_radius_percentage);
				if (!Number.isFinite(radius) || radius < 0 || radius > 100) issues.push({ path: `board.design_settings.tuning_pattern_settings.${ name }.corner_radius_percentage`, message: 'Corner radius percentage must be between 0 and 100.' });
			}
		}
		return issues;
	}

	protected validateBoardFileSettings(): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		if (!this.draftBoardRoot) return issues;
		const layers = this.boardLayers;
		const ids = new Set<number>();
		const names = new Set<string>();
		for (const layer of layers) {
			if (ids.has(layer.id)) issues.push({ path: 'board.layers', message: `Board layer id ${ layer.id } is duplicated.` });
			if (names.has(layer.name)) issues.push({ path: 'board.layers', message: `Board layer name “${ layer.name }” is duplicated.` });
			ids.add(layer.id); names.add(layer.name);
		}
		if (!ids.has(0) || !ids.has(2)) issues.push({ path: 'board.layers', message: 'F.Cu and B.Cu are required board layers.' });
		if (this.copperLayerCount < 2 || this.copperLayerCount > 32 || this.copperLayerCount % 2 !== 0) {
			issues.push({ path: 'board.layers', message: 'Copper layer count must be an even number between 2 and 32.' });
		}
		const dielectricCount = this.stackupLayers.filter(layer => /^dielectric(\s+\d+)?$/i.test(layer.name)).length;
		if (this.stackupLayers.length && dielectricCount !== Math.max(this.copperLayerCount - 1, 0)) {
			issues.push({ path: 'board.stackup', message: `The stackup needs ${ Math.max(this.copperLayerCount - 1, 0) } dielectric layer(s) for ${ this.copperLayerCount } copper layers, but has ${ dielectricCount }.` });
		}
		for (const layer of this.stackupLayers) {
			if (layer.thickness !== undefined && (!Number.isFinite(layer.thickness) || layer.thickness < 0)) {
				issues.push({ path: `board.stackup.${ layer.name }.thickness`, message: `${ layer.name }: thickness must be a non-negative number.` });
			}
			if (layer.epsilonR !== undefined && (!Number.isFinite(layer.epsilonR) || layer.epsilonR <= 0)) {
				issues.push({ path: `board.stackup.${ layer.name }.epsilon_r`, message: `${ layer.name }: relative permittivity must be positive.` });
			}
			if (layer.lossTangent !== undefined && (!Number.isFinite(layer.lossTangent) || layer.lossTangent < 0)) {
				issues.push({ path: `board.stackup.${ layer.name }.loss_tangent`, message: `${ layer.name }: loss tangent must be non-negative.` });
			}
		}
		if (!Number.isFinite(this.boardThickness) || this.boardThickness <= 0) issues.push({ path: 'board.general.thickness', message: 'Board thickness must be positive.' });
		for (const [name, label] of [
			['pad_to_mask_clearance', 'Solder mask expansion'],
			['solder_mask_min_width', 'Minimum solder mask width'],
			['pad_to_paste_clearance', 'Solder paste clearance'],
			['pad_to_paste_clearance_ratio', 'Solder paste clearance ratio']
		] as const) {
			const value = this.getSetup()?.getSimpleChildValue(name);
			if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) issues.push({ path: `board.setup.${ name }`, message: `${ label } must be numeric.` });
		}
		if (this.getBoardSetupNumber('solder_mask_min_width', 0) < 0) issues.push({ path: 'board.setup.solder_mask_min_width', message: 'Minimum solder mask width cannot be negative.' });
		if (Math.abs(this.getBoardSetupNumber('pad_to_paste_clearance_ratio', 0)) > 1) issues.push({ path: 'board.setup.pad_to_paste_clearance_ratio', message: 'Solder paste clearance ratio must be between -1 and 1.' });
		return issues;
	}
}
