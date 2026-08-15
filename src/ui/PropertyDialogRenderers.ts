import type { KicadDirectiveLabelShape, KicadGlobalLabelShape } from '@kicad-render/KicadRenderSession';
import { PropertiesDialog, type KdGridColumn }                  from './PropertiesDialog';

export interface PropertyDialogRendererHost {
	getSession: () => any;
	mutateElement: (id: string) => (fn: (element: any) => void) => void;
	mutateSymbol: (id: string) => (fn: (symbol: any) => void) => void;
	mutateLibrary: (id: string) => (fn: (symbol: any) => void) => void;
	refresh: (session: any) => void;
	refreshUndo: () => void;
	show: (id: string) => void;
	/** Opens the Footprint Chooser dialog (apps/kicad-viewer/src/ui/
	 *  FootprintChooser.ts); resolves the chosen "Library:Name" id or null
	 *  on cancel. Same host-interface decoupling as PropertyRenderers'
	 *  identical method. */
	openFootprintChooser: (context: { fpFilters: string[]; pinCount: number }) => Promise<string | null>;
}

const LINE_STYLE_OPTIONS = [
	{ value: 'default', label: 'Default' }, { value: 'solid', label: 'Solid' }, { value: 'dash', label: 'Dashed' },
	{ value: 'dot', label: 'Dotted' }, { value: 'dash_dot', label: 'Dash-Dot' },
	{ value: 'dash_dot_dot', label: 'Dash-Dot-Dot' }
];
const FILL_TYPE_OPTIONS = [
	{ value: 'none', label: 'None' }, { value: 'color', label: 'Custom Color' },
	{ value: 'outline', label: 'Same As Border' }, { value: 'background', label: 'Body Background' }
];
const GLOBAL_HIER_SHAPE_OPTIONS = [
	{ value: 'input', label: 'Input' }, { value: 'output', label: 'Output' },
	{ value: 'bidirectional', label: 'Bidirectional' },
	{ value: 'tri_state', label: 'Tri-State' }, { value: 'passive', label: 'Passive' }
];
const DIRECTIVE_SHAPE_OPTIONS = [
	{ value: 'dot', label: 'Dot' }, { value: 'round', label: 'Circle' }, { value: 'diamond', label: 'Diamond' },
	{ value: 'rectangle', label: 'Rectangle' }
];
const SHAPE_TITLES: Record<string, string> = {
	rectangle: 'Rectangle',
	circle: 'Circle',
	arc: 'Arc',
	polyline: 'Polyline',
	bezier: 'Bezier'
};
const LABEL_DIALOG_TITLES: Record<string, string> = {
	local: 'Label Properties',
	global: 'Global Label Properties',
	hier: 'Hierarchical Label Properties',
	directive: 'Directive Label Properties'
};
const H_ALIGN_OPTIONS = [
	{ value: 'left', label: 'Left' }, { value: 'middle', label: 'Center' }, { value: 'right', label: 'Right' }
];
const V_ALIGN_OPTIONS = [
	{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Center' }, { value: 'bottom', label: 'Bottom' }
];

export class PropertyDialogRenderers {
	constructor(protected readonly dialog: PropertiesDialog, protected readonly host: PropertyDialogRendererHost) {}

	protected get body(): HTMLElement { return this.dialog.body; }

	protected rgb(hex: string): [number, number, number, number] {
		const value = parseInt(hex.slice(1), 16);
		return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 1];
	}

	protected row(container: HTMLElement): HTMLElement { return this.dialog.row(container); }

	protected label(row: HTMLElement, text: string): void { this.dialog.label(row, text); }

	protected unit(row: HTMLElement, text: string): void { this.dialog.unit(row, text); }

	protected input(
		row: HTMLElement, value: string, save: (value: string) => void, numeric = false): void {
		this.dialog.textInput(row, value, save, numeric);
	}

	protected select(
		row: HTMLElement, value: string, options: { value: string; label: string }[],
		save: (value: string) => void
	): void { this.dialog.select(row, value, options, save); }

	protected swatch(
		row: HTMLElement, value: string | null | undefined, save: (hex: string) => void): void {
		this.dialog.swatch(
			row, value, save);
	}

	protected check(
		container: HTMLElement, text: string, checked: boolean,
		save: (value: boolean) => void
	): void { this.dialog.checkRow(container, text, checked, save); }

	protected section(container: HTMLElement, title: string): HTMLElement {
		return this.dialog.section(
			container, title);
	}

	protected columns(container: HTMLElement): [HTMLElement, HTMLElement] { return this.dialog.columns(container); }

	protected mutateElement(id: string): (fn: (element: any) => void) => void { return this.host.mutateElement(id); }

	protected mutateSymbol(id: string): (fn: (symbol: any) => void) => void { return this.host.mutateSymbol(id); }

	protected mutateLibrary(id: string): (fn: (symbol: any) => void) => void { return this.host.mutateLibrary(id); }

	renderJunction(junction: any, id: string): void {
		this.dialog.setTitle('Junction Properties');
		const mutate = this.mutateElement(id);
		const diameter = this.row(this.body);
		this.label(diameter, 'Diameter:');
		this.input(diameter, junction.getDiameter().toFixed(2), value => {
			const number = Number(value);
			if (Number.isFinite(number) && number >= 0) {
				mutate(current => current.setDiameter(number));
			}
		}, true);
		this.unit(diameter, 'mm');
		const color = this.row(this.body);
		this.label(color, 'Color:');
		this.swatch(color, junction.getColorOverride?.(), hex => mutate(current => current.setColor(...this.rgb(hex))));
		this.dialog.help(this.body, 'Set diameter to 0 to use schematic\'s junction dot size.');
		this.dialog.help(this.body, 'Clear color to use Schematic Editor colors.');
		const buttons = this.dialog.buttonRow(this.body);
		this.dialog.button(buttons, 'Default', () => {
			mutate(current => {
				current.setDiameter(0);
				current.setColor(0, 0, 0, 0);
			});
			this.host.show(id);
		});
	}

	renderWireBus(element: any, kind: string, id: string): void {
		const label = kind === 'bus' ? 'Bus' : (typeof element.getSize === 'function' ? 'Bus Entry' : 'Wire');
		this.dialog.setTitle(`${ label } Properties`);
		const mutate = this.mutateElement(id);
		const stroke = element.getStroke();
		const width = this.row(this.body);
		this.label(width, `${ label } width:`);
		this.input(width, stroke.width.toFixed(2), value => {
			const number = Number(value);
			if (Number.isFinite(number) && number >= 0) {
				mutate(
					current => current.setStroke(number, current.getStroke().type));
			}
		}, true);
		this.unit(width, 'mm');
		this.label(width, 'Color:');
		this.swatch(
			width, element.getStrokeColorOverride?.(),
			hex => mutate(current => current.setStrokeColor(...this.rgb(hex)))
		);
		const style = this.row(this.body);
		this.label(style, 'Style:');
		this.select(
			style, stroke.type, LINE_STYLE_OPTIONS,
			value => mutate(current => current.setStroke(current.getStroke().width, value))
		);
		this.dialog.help(this.body, 'Set width to 0 to use netclass\'s wire/bus widths.');
		this.dialog.help(this.body, 'Clear color to use Schematic Editor colors.');
		const buttons = this.dialog.buttonRow(this.body);
		this.dialog.button(buttons, 'Default', () => {
			mutate(current => {
				current.setStroke(0, 'default');
				current.setStrokeColor(0, 0, 0, 0);
			});
			this.host.show(id);
		});
	}

	renderShape(element: any, kind: string, id: string): void {
		const isRuleArea = typeof element.getPolyline === 'function';
		const strokeTarget = isRuleArea ? element.getPolyline() : element;
		const freshTarget = (current: any) => isRuleArea ? current.getPolyline() : current;
		const title = kind === 'symbol-graphic' ? (element.name ?? 'shape') : kind;
		this.dialog.setTitle(`${ isRuleArea ? 'Rule Area' : (SHAPE_TITLES[title] ?? 'Shape') } Properties`);
		const mutate = this.mutateElement(id);
		if (isRuleArea) {
			this.check(
				this.body, 'Exclude from simulation', !!element.isExcludedFromSim?.(),
				value => mutate(current => current.setExcludedFromSim(value))
			);
			this.check(
				this.body, 'Exclude from board', !element.isOnBoard?.(),
				value => mutate(current => current.setOnBoard(!value))
			);
			this.check(
				this.body, 'Do not populate', !!element.isDnp?.(), value => mutate(current => current.setDnp(value)));
			this.check(
				this.body, 'Exclude from bill of materials', !element.isInBom?.(),
				value => mutate(current => current.setInBom(!value))
			);
		}
		const [borderCol, fillCol] = this.columns(this.body);
		if (strokeTarget && typeof strokeTarget.getStroke === 'function') {
			const border = this.section(borderCol, 'Border');
			const stroke = strokeTarget.getStroke();
			const width = this.row(border);
			this.label(width, 'Width:');
			this.input(width, stroke.width.toFixed(2), value => {
				const number = Number(value);
				if (Number.isFinite(number) && number >= 0) {
					mutate(current => {
						const target = freshTarget(current);
						target.setStroke(number, target.getStroke().type);
					});
				}
			}, true);
			this.unit(width, 'mm');
			this.label(width, 'Color:');
			this.swatch(
				width, strokeTarget.getStrokeColorOverride?.(),
				hex => mutate(current => freshTarget(current).setStrokeColor(...this.rgb(hex)))
			);
			const style = this.row(border);
			this.label(style, 'Style:');
			this.select(
				style, stroke.type, LINE_STYLE_OPTIONS, value => mutate(current => {
					const target = freshTarget(current);
					target.setStroke(target.getStroke().width, value);
				}));
			this.dialog.help(border, 'Set border width to 0 to use schematic\'s default line width.');
		}
		if (strokeTarget && typeof strokeTarget.getFill === 'function' && strokeTarget.name !== 'bezier') {
			const fill = this.section(fillCol, 'Fill');
			const fillRow = this.row(fill);
			this.label(fillRow, 'Fill:');
			this.select(
				fillRow, strokeTarget.getFill(), FILL_TYPE_OPTIONS,
				value => mutate(current => freshTarget(current).setFill(value))
			);
			const fillColor = this.row(fill);
			this.label(fillColor, 'Fill color:');
			this.swatch(
				fillColor, strokeTarget.getFillColorOverride?.(),
				hex => mutate(current => freshTarget(current).setFillColor(...this.rgb(hex)))
			);
			this.dialog.help(fill, 'Clear colors to use Schematic Editor colors.');
		}
	}

	renderText(element: any, id: string): void {
		const isTextBox = element.name === 'text_box';
		this.dialog.setTitle(isTextBox ? 'Text Box Properties' : 'Text Properties');
		const mutate = this.mutateElement(id);
		this.dialog.textArea(
			this.body, String(element.value ?? ''), value => mutate(current => { current.value = value; }),
			isTextBox ? 4 : 3
		);
		const font = typeof element.getFont === 'function' ? element.getFont() :
			{ width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
		const row = this.row(this.body);
		this.label(row, 'Text size:');
		this.input(row, (font.height || 1.27).toFixed(2), value => {
			const number = Number(value);
			if (Number.isFinite(number) && number > 0) {
				mutate(current => {
					const f = current.getFont();
					current.setFont(number, number, f.italic, f.bold, f.thickness);
				});
			}
		}, true);
		this.unit(row, 'mm');
		this.dialog.inlineCheck(row, 'Bold', !!font.bold, value => mutate(current => {
			const f = current.getFont();
			current.setFont(f.width || 1.27, f.height || 1.27, f.italic, value, f.thickness);
		}));
		this.dialog.inlineCheck(row, 'Italic', !!font.italic, value => mutate(current => {
			const f = current.getFont();
			current.setFont(f.width || 1.27, f.height || 1.27, value, f.bold, f.thickness);
		}));
		this.label(row, 'Color:');
		this.swatch(
			row, element.getFontColorOverride?.(), hex => mutate(current => current.setFontColor(...this.rgb(hex))));
		if (isTextBox) {
			const [borderCol, fillCol] = this.columns(this.body);
			const border = this.section(borderCol, 'Border');
			const stroke = element.getStroke();
			const width = this.row(border);
			this.label(width, 'Width:');
			this.input(width, stroke.width.toFixed(2), value => {
				const number = Number(value);
				if (Number.isFinite(number) && number >= 0) {
					mutate(
						current => current.setStroke(number, current.getStroke().type));
				}
			}, true);
			this.unit(width, 'mm');
			this.label(width, 'Color:');
			this.swatch(
				width, element.getStrokeColorOverride?.(),
				hex => mutate(current => current.setStrokeColor(...this.rgb(hex)))
			);
			const style = this.row(border);
			this.label(style, 'Style:');
			this.select(
				style, stroke.type, LINE_STYLE_OPTIONS,
				value => mutate(current => current.setStroke(current.getStroke().width, value))
			);
			const fill = this.section(fillCol, 'Fill');
			const fillRow = this.row(fill);
			this.label(fillRow, 'Fill:');
			this.select(
				fillRow, element.getFill(), FILL_TYPE_OPTIONS, value => mutate(current => current.setFill(value)));
			const fillColor = this.row(fill);
			this.label(fillColor, 'Fill color:');
			this.swatch(
				fillColor, element.getFillColorOverride?.(),
				hex => mutate(current => current.setFillColor(...this.rgb(hex)))
			);
		}
	}

	renderLabel(element: any, labelKind: string | undefined, id: string): void {
		this.dialog.setTitle(LABEL_DIALOG_TITLES[labelKind ?? ''] ?? 'Label Properties');
		const mutate = this.mutateElement(id);
		const isDirective = labelKind === 'directive';
		const hasShape = labelKind === 'global' || labelKind === 'hier' || isDirective;
		if (!isDirective) {
			const row = this.row(this.body);
			this.label(row, 'Label:');
			const current = typeof element.getName === 'function' ? element.getName() : String(element.value ?? '');
			this.input(row, current, value => {
				const session = this.host.getSession();
				if (!session?.renameLabel(id, value)) {
					return;
				}
				this.host.refresh(session);
				this.host.refreshUndo();
			});
		}
		if (hasShape) {
			const [shapeCol, formatCol] = this.columns(this.body);
			const shape = this.section(shapeCol, 'Shape');
			const current = element.getShape?.() ?? (isDirective ? 'round' : 'input');
			const options = isDirective ? DIRECTIVE_SHAPE_OPTIONS : GLOBAL_HIER_SHAPE_OPTIONS;
			for (const option of options) {
				this.dialog.radioRow(
					shape, `label-shape-${ id }`, option.label, current === option.value, () => {
						const session = this.host.getSession();
						if (!session?.setLabelShape(
							id, option.value as KicadGlobalLabelShape | KicadDirectiveLabelShape)) {
							return;
						}
						this.host.refresh(session);
						this.host.refreshUndo();
					});
			}
			this.renderLabelFormatting(formatCol, element, id, isDirective, mutate);
		}
		else {
			this.renderLabelFormatting(this.body, element, id, isDirective, mutate);
		}
	}

	protected renderLabelFormatting(
		container: HTMLElement, element: any, id: string, isDirective: boolean,
		mutate: (fn: (element: any) => void) => void
	): void {
		const formatting = this.section(container, 'Formatting');
		if (isDirective) {
			const row = this.row(formatting);
			this.label(row, 'Pin length:');
			this.input(
				row, Number(element.getPinLength?.() ?? 2.54).toFixed(2), value => {
					const number = Number(value);
					if (Number.isFinite(number) && number >= 0) {
						mutate(current => current.setPinLength(number));
					}
				}, true);
			this.unit(row, 'mm');
			return;
		}
		const font = typeof element.getFont === 'function' ? element.getFont() :
			{ width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
		const row = this.row(formatting);
		this.label(row, 'Text size:');
		this.input(row, (font.height || 1.27).toFixed(2), value => {
			const number = Number(value);
			if (Number.isFinite(number) && number > 0) {
				mutate(current => {
					const f = current.getFont();
					current.setFont(number, number, f.italic, f.bold, f.thickness);
				});
			}
		}, true);
		this.unit(row, 'mm');
		this.dialog.inlineCheck(row, 'Bold', !!font.bold, value => mutate(current => {
			const f = current.getFont();
			current.setFont(f.width || 1.27, f.height || 1.27, f.italic, value, f.thickness);
		}));
		this.dialog.inlineCheck(row, 'Italic', !!font.italic, value => mutate(current => {
			const f = current.getFont();
			current.setFont(f.width || 1.27, f.height || 1.27, value, f.bold, f.thickness);
		}));
		const color = this.row(formatting);
		this.label(color, 'Color:');
		this.swatch(
			color, element.getFontColorOverride?.(), hex => mutate(current => current.setFontColor(...this.rgb(hex))));
	}

	renderSymbol(symbol: any, id: string): void {
		this.dialog.setTitle('Symbol Properties');
		const mutate = this.mutateSymbol(id);
		const session = this.host.getSession();
		const libDef = session?.findLibSymbolForInstance(id) ?? null;
		const fields = this.section(this.body, 'Fields');
		const properties = symbol.getProperties?.() ?? [];
		const mandatory = new Set(['Reference', 'Value', 'Footprint', 'Datasheet']);
		const rows = properties.map((property: any) => {
			const justify = property.getJustify?.() ?? { horizontal: 'left', vertical: 'top' };
			const font = property.getFont?.() ?? { bold: false, italic: false };
			return {
				Name: property.propertyName ?? '',
				Value: property.propertyValue ?? '',
				Show: !property.isHidden?.(),
				ShowName: !!property.getShowName?.(),
				HAlign: justify.horizontal,
				VAlign: justify.vertical,
				Italic: !!font.italic,
				Bold: !!font.bold
			};
		});
		const columns: KdGridColumn[] = [
			{
				key: 'Name',
				label: 'Name',
				type: 'text',
				readOnly: row => mandatory.has(String(row.Name))
			}, {
				key: 'Value', label: 'Value', type: 'text',
				button: row => row.Name === 'Footprint' ? () => {
					void this.host.openFootprintChooser({
						fpFilters: libDef?.getFPFilters?.() ?? [], pinCount: libDef?.getPinCount?.() ?? 0
					}).then(fpId => {
						if (fpId) {
							mutate(current => current.setProperty('Footprint', fpId));
							this.host.show(id);
						}
					});
				} : null
			}, { key: 'Show', label: 'Show', type: 'checkbox' },
			{ key: 'ShowName', label: 'Show Name', type: 'checkbox' },
			{ key: 'HAlign', label: 'H Align', type: 'select', options: H_ALIGN_OPTIONS },
			{ key: 'VAlign', label: 'V Align', type: 'select', options: V_ALIGN_OPTIONS },
			{ key: 'Italic', label: 'Italic', type: 'checkbox' }, { key: 'Bold', label: 'Bold', type: 'checkbox' }
		];
		this.dialog.grid(fields, columns, rows, {
			onCellChange: (rowIndex, key, value) => mutate(current => {
				const property = current.getProperties?.()?.[rowIndex];
				if (!property) {
					return;
				}
				switch (key) {
					case 'Name':
						property.propertyName = String(value);
						break;
					case 'Value':
						property.propertyValue = String(value);
						break;
					case 'Show':
						property.setHidden?.(!value);
						break;
					case 'ShowName':
						property.setShowName?.(!!value);
						break;
					case 'HAlign':
						property.setJustify?.(value as any, property.getJustify?.().vertical);
						break;
					case 'VAlign':
						property.setJustify?.(property.getJustify?.().horizontal, value as any);
						break;
					case 'Italic': {
						const font = property.getFont?.() ?? {};
						property.setFont?.(
							font.width || 1.27, font.height || 1.27, !!value, font.bold, font.thickness);
						break;
					}
					case 'Bold': {
						const font = property.getFont?.() ?? {};
						property.setFont?.(
							font.width || 1.27, font.height || 1.27, font.italic, !!value, font.thickness);
						break;
					}
				}
			}),
			onAddRow: () => {
				mutate(current => current.setProperty?.(`Field${ (current.getProperties?.()?.length ?? 0) + 1 }`, ''));
				this.host.show(id);
			},
			onRemoveRow: rowIndex => {
				mutate(current => {
					const property = current.getProperties?.()?.[rowIndex];
					if (property) {
						current.deleteProperty?.(property.propertyName);
					}
				});
				this.host.show(id);
			},
			canRemoveRow: rowIndex => !mandatory.has(String(rows[rowIndex]?.Name))
		});
		const [generalCol, attributesCol] = this.columns(this.body);
		const general = this.section(generalCol, 'General');
		const origin = symbol.getOrigin?.();
		if (origin) {
			const rotation = ((Math.round(Number(origin.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
			const angle = this.row(general);
			this.label(angle, 'Angle:');
			this.select(
				angle, String(rotation), ['0', '90', '180', '270'].map(value => ({ value, label: `${ value }°` })),
				value => mutate(current => {
					const live = current.getOrigin();
					current.setOrigin(live.x, live.y, Number(value));
				})
			);
			const x = this.row(general);
			this.label(x, 'Position X:');
			this.input(x, origin.x.toFixed(2), value => mutate(current => {
				const live = current.getOrigin();
				current.setOrigin(Number(value) || 0, live.y, live.rotation ?? 0);
			}), true);
			this.unit(x, 'mm');
			const y = this.row(general);
			this.label(y, 'Position Y:');
			this.input(y, origin.y.toFixed(2), value => mutate(current => {
				const live = current.getOrigin();
				current.setOrigin(live.x, Number(value) || 0, live.rotation ?? 0);
			}), true);
			this.unit(y, 'mm');
		}
		this.check(
			general, 'Show pin numbers', !libDef?.arePinNumbersHidden?.(),
			value => this.mutateLibrary(id)(current => current.togglePinNumbers(value))
		);
		this.check(
			general, 'Show pin names', !libDef?.arePinNameLabelsHidden?.(),
			value => this.mutateLibrary(id)(current => current.togglePinNames(value))
		);
		const attributes = this.section(attributesCol, 'Attributes');
		this.check(
			attributes, 'Exclude from simulation', !!symbol.findFirstChildByName?.('exclude_from_sim')?.value,
			value => mutate(current => current.setExcludeFromSim(value))
		);
		this.check(
			attributes, 'Exclude from board', symbol.findFirstChildByName?.('on_board')?.value === false,
			value => mutate(current => current.setOnBoard(!value))
		);
		this.check(
			attributes, 'Do not populate', !!symbol.isDnp?.(), value => mutate(current => current.setDnp(value)));
		this.check(
			attributes, 'Exclude from bill of materials', symbol.findFirstChildByName?.('in_bom')?.value === false,
			value => mutate(current => current.setInBom(!value))
		);
		this.check(
			attributes, 'Exclude from position files', symbol.findFirstChildByName?.('in_pos_files')?.value === false,
			value => mutate(current => current.setInPosFiles(!value))
		);
		const link = this.row(this.body);
		this.label(link, 'Library link:');
		const text = document.createElement('span');
		text.style.color = 'var(--text)';
		text.style.fontSize = '11px';
		text.textContent = symbol.getLibId?.() ?? '';
		link.appendChild(text);
	}
}
