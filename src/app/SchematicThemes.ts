import {
	setSchematicTheme,
	type SchematicColorName,
	type SchematicColorSet
} from '@kicad-render/paint/SchematicColors';

export type SchematicThemeId = 'wdark' | 'kicad-default' | 'kicad-classic';
export type SchematicThemeColor = 'background' | 'grid' | SchematicColorName;
export type SchematicColorOverrides = Partial<Record<SchematicThemeColor, string>>;

export interface SchematicThemePreset {
	label: string;
	background: string;
	grid: string;
	colors: SchematicColorSet;
}

const wDark: SchematicThemePreset = {
	label: 'wDark', background: '#282c34', grid: '#b9c6d6',
	colors: {
		wire: '#98c379', bus: '#61afef', junction: '#98c379', noConnect: '#61afef',
		componentOutline: '#e06c75', componentBody: '#545862', pin: '#e06c75', pinName: '#98c379',
		pinNumber: '#e06c75', reference: '#56b6c2', value: '#56b6c2', fields: '#56b6c2',
		labelLocal: '#e5c07b', labelGlobal: '#e06c75', labelHier: '#c678dd', labelDirective: '#484848',
		ruleArea: '#ff0000', sheet: '#c678dd', sheetBackground: '#000000', sheetFields: '#840084',
		sheetFilename: '#c678dd', sheetLabel: '#c678dd', note: '#61afef', dnpMarker: '#dc090d',
		graphic: '#61afef', frame: '#7f848e'
	}
};

const kicadDefault: SchematicThemePreset = {
	label: 'KiCad Default', background: '#f5f4ef', grid: '#b5b5b5',
	colors: {
		wire: '#009600', bus: '#000084', junction: '#009600', noConnect: '#000084',
		componentOutline: '#840000', componentBody: '#ffffc2', pin: '#840000', pinName: '#006464',
		pinNumber: '#a90000', reference: '#006464', value: '#006464', fields: '#840084',
		labelLocal: '#0f0f0f', labelGlobal: '#840000', labelHier: '#725600', labelDirective: '#484848',
		ruleArea: '#ff0000', sheet: '#840000', sheetBackground: '#ffffff', sheetFields: '#840084',
		sheetFilename: '#725600', sheetLabel: '#006464', note: '#0000c2', dnpMarker: '#dc090d',
		graphic: '#0000c2', frame: '#840000'
	}
};

const kicadClassic: SchematicThemePreset = {
	label: 'KiCad Classic', background: '#ffffff', grid: '#b5b5b5',
	colors: {
		...kicadDefault.colors,
		wire: '#008000', bus: '#0000ff', junction: '#008000', noConnect: '#0000ff',
		componentOutline: '#ff0000', componentBody: '#ffffe0', pin: '#ff0000', pinName: '#008080',
		pinNumber: '#ff0000', reference: '#008080', value: '#008080', fields: '#ff00ff',
		labelLocal: '#000000', labelGlobal: '#ff0000', labelHier: '#808000', sheet: '#ff0000',
		sheetFields: '#ff00ff', sheetFilename: '#808000', sheetLabel: '#008080', note: '#0000ff',
		graphic: '#0000ff', frame: '#ff0000'
	}
};

export const SCHEMATIC_THEME_PRESETS: Readonly<Record<SchematicThemeId, SchematicThemePreset>> = {
	wdark: wDark,
	'kicad-default': kicadDefault,
	'kicad-classic': kicadClassic
};

export const SCHEMATIC_COLOR_FIELDS: readonly [SchematicThemeColor, string][] = [
	['background', 'Schematic background'], ['grid', 'Grid'], ['wire', 'Wire'], ['bus', 'Bus'],
	['junction', 'Junction'], ['noConnect', 'No connection'], ['componentOutline', 'Symbol outline'],
	['componentBody', 'Symbol fill'], ['pin', 'Pin'], ['pinName', 'Pin name'], ['pinNumber', 'Pin number'],
	['reference', 'Reference field'], ['value', 'Value field'], ['fields', 'Other fields'],
	['labelLocal', 'Local label'], ['labelGlobal', 'Global label'], ['labelHier', 'Hierarchical label'],
	['labelDirective', 'Directive label'], ['ruleArea', 'Rule area'], ['sheet', 'Sheet border'],
	['sheetBackground', 'Sheet fill'], ['sheetFields', 'Sheet fields'], ['sheetFilename', 'Sheet filename'],
	['sheetLabel', 'Sheet pin label'], ['note', 'Text and notes'], ['dnpMarker', 'DNP marker'],
	['graphic', 'Graphic item'], ['frame', 'Drawing sheet']
];

export function themeColor(theme: SchematicThemeId, overrides: SchematicColorOverrides, color: SchematicThemeColor): string {
	if (color === 'background' || color === 'grid') {
		return overrides[color] ?? SCHEMATIC_THEME_PRESETS[theme][color];
	}
	return overrides[color] ?? SCHEMATIC_THEME_PRESETS[theme].colors[color];
}

export function applySchematicTheme(theme: SchematicThemeId, overrides: SchematicColorOverrides): void {
	const preset = SCHEMATIC_THEME_PRESETS[theme];
	const colors = { ...preset.colors };
	for (const [name, color] of Object.entries(overrides)) {
		if (name !== 'background' && name !== 'grid' && name in colors) {
			colors[name as SchematicColorName] = color;
		}
	}
	setSchematicTheme(overrides.background ?? preset.background, overrides.grid ?? preset.grid, colors);
}
