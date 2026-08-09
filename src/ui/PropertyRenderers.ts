import type { KicadDirectiveLabelShape, KicadGlobalLabelShape } from '@kicad-render/KicadRenderSession';
import { PropertyPanel }                                        from './PropertyPanel';

export interface PropertyRendererHost {
	getSession: () => any;
	refreshSchematicText: (session: any) => void;
	refreshUndoStack: () => void;
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
	{ value: 'bidirectional', label: 'Bidirectional' }, { value: 'tri_state', label: 'Tri-State' },
	{ value: 'passive', label: 'Passive' }
];
const DIRECTIVE_SHAPE_OPTIONS = [
	{ value: 'dot', label: 'Dot' }, { value: 'round', label: 'Circle' },
	{ value: 'diamond', label: 'Diamond' }, { value: 'rectangle', label: 'Rectangle' }
];

export const MULTI_EDIT_NAMES = new Set([
	'wire', 'bus', 'bus_entry', 'junction', 'rectangle', 'circle', 'arc', 'polyline', 'bezier', 'rule_area', 'text',
	'text_box'
]);

export class PropertyRenderers {
	constructor(protected readonly panel: PropertyPanel, protected readonly host: PropertyRendererHost) {}

	protected session(): any { return this.host.getSession(); }

	protected clear(): void { this.panel.clear(); }

	protected section(title: string): HTMLElement { return this.panel.section(title); }

	protected row(
		section: HTMLElement, label: string, value: string, edit = false,
		save?: (value: string) => void
	): void { this.panel.row(section, label, value, edit, save); }

	protected select(
		section: HTMLElement, label: string, value: string, options: { value: string; label: string }[],
		save: (value: string) => void
	): void { this.panel.select(section, label, value, options, save); }

	protected check(
		section: HTMLElement, label: string, checked: boolean,
		save: (value: boolean) => void
	): void { this.panel.checkbox(section, label, checked, save); }

	protected color(
		section: HTMLElement, label: string, value: string | null | undefined,
		save: (value: string) => void
	): void { this.panel.color(section, label, value, save); }

	protected rgb(hex: string): [number, number, number, number] {
		const value = parseInt(hex.slice(1), 16);
		return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 1];
	}

	protected symbolMutator(id: string): (fn: (symbol: any) => void) => void {
		return fn => {
			const session = this.session();
			if (!session?.mutateSymbolByPaintId(id, fn)) {
				return;
			}
			this.host.refreshSchematicText(session);
			this.host.refreshUndoStack();
		};
	}

	protected elementMutator(id: string): (fn: (element: any) => void) => void {
		return fn => {
			const session = this.session();
			if (!session?.mutateElementByPaintId(id, fn)) {
				return;
			}
			this.host.refreshSchematicText(session);
			this.host.refreshUndoStack();
		};
	}

	protected elementsMutator(ids: string[]): (fn: (element: any) => void) => void {
		return fn => {
			const session = this.session();
			const count = session?.mutateElementsByPaintIds(ids, fn) ?? 0;
			if (!count) {
				return;
			}
			this.host.refreshSchematicText(session);
			this.host.refreshUndoStack();
		};
	}

	protected position(section: HTMLElement, origin: any, mutate: (fn: (element: any) => void) => void): void {
		this.row(
			section, 'Position X (mm)', origin ? origin.x.toFixed(2) : '—', !!origin, value => {
				if (origin) {
					mutate(current => {
						const live = current.getOrigin();
						current.setOrigin(Number(value) || 0, live.y, live.rotation ?? 0);
					});
				}
			});
		this.row(
			section, 'Position Y (mm)', origin ? origin.y.toFixed(2) : '—', !!origin, value => {
				if (origin) {
					mutate(current => {
						const live = current.getOrigin();
						current.setOrigin(live.x, Number(value) || 0, live.rotation ?? 0);
					});
				}
			});
		if (origin) {
			const rotation = ((Math.round(Number(origin.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
			this.select(
				section, 'Orientation', String(rotation),
				['0', '90', '180', '270'].map(value => ({ value, label: `${ value }°` })), value => mutate(current => {
					const live = current.getOrigin();
					current.setOrigin(live.x, live.y, Number(value));
				})
			);
		}
	}

	renderSymbol(symbol: any, kind: string, id: string): void {
		this.clear();
		const mutate = this.symbolMutator(id);
		const session = this.session();
		const libDef = session?.findLibSymbolForInstance(id) ?? null;
		const mutateLibDef = (fn: (current: any) => void) => {
			if (!session?.mutateLibSymbolForInstance(id, fn)) {
				return;
			}
			this.host.refreshSchematicText(session);
			this.host.refreshUndoStack();
		};
		const basic = this.section('Basic Properties');
		this.check(
			basic, 'Pin numbers', !libDef?.arePinNumbersHidden?.(),
			value => mutateLibDef(current => current.togglePinNumbers(value))
		);
		this.check(
			basic, 'Pin names', !libDef?.arePinNameLabelsHidden?.(),
			value => mutateLibDef(current => current.togglePinNames(value))
		);
		this.position(basic, symbol.getOrigin?.(), mutate);
		this.row(basic, 'Object', `${ kind } (${ id.slice(0, 8) })`);
		const fields = this.section('Fields');
		for (const property of symbol.getProperties?.() ?? []) {
			const name = String(property.propertyName ?? '');
			if (name) {
				this.row(
					fields, name, String(property.propertyValue ?? ''), true,
					value => mutate(current => current.setProperty(name, value))
				);
			}
		}
		const attrs = this.section('Attributes');
		this.check(
			attrs, 'Exclude From Simulation', !!symbol.findFirstChildByName?.('exclude_from_sim')?.value,
			value => mutate(current => current.setExcludeFromSim(value))
		);
		this.check(attrs, 'Do Not Populate', !!symbol.isDnp?.(), value => mutate(current => current.setDnp(value)));
		this.check(
			attrs, 'Exclude From BOM', symbol.findFirstChildByName?.('in_bom')?.value === false,
			value => mutate(current => current.setInBom(!value))
		);
		this.check(
			attrs, 'Exclude From Board', symbol.findFirstChildByName?.('on_board')?.value === false,
			value => mutate(current => current.setOnBoard(!value))
		);
		this.check(
			attrs, 'Exclude From Position Files', symbol.findFirstChildByName?.('in_pos_files')?.value === false,
			value => mutate(current => current.setInPosFiles(!value))
		);
		const pin = this.section('Pin Display');
		this.check(
			pin, 'Show Pin Number', !libDef?.arePinNumbersHidden?.(),
			value => mutateLibDef(current => current.togglePinNumbers(value))
		);
		this.check(
			pin, 'Show Pin Name', !libDef?.arePinNameLabelsHidden?.(),
			value => mutateLibDef(current => current.togglePinNames(value))
		);
		const pinNames = libDef?.findFirstChildByName?.('pin_names');
		this.row(
			pin, 'Pin Name Offset (mm)', Number(pinNames?.getOffset?.() ?? 0).toFixed(2), true,
			value => mutateLibDef(current => current.setPinNameOffset(Number(value) || 0))
		);
	}

	renderShape(element: any, kind: string, id: string): void {
		this.clear();
		const mutate = this.elementMutator(id);
		const isRuleArea = typeof element.getPolyline === 'function';
		const strokeTarget = isRuleArea ? element.getPolyline() : element;
		const freshTarget = (current: any) => isRuleArea ? current.getPolyline() : current;
		const basic = this.section('Basic Properties');
		this.row(
			basic, 'Object', `${ kind === 'symbol-graphic' ? (element.name ?? 'shape') : kind } (${ id.slice(0, 8) })`);
		if (strokeTarget && typeof strokeTarget.getStroke === 'function') {
			const border = this.section('Border');
			const stroke = strokeTarget.getStroke();
			this.row(border, 'Width (mm)', stroke.width.toFixed(2), true, value => {
				const width = Number(value);
				if (Number.isFinite(width) && width >= 0) {
					mutate(current => {
						const target = freshTarget(current);
						target.setStroke(width, target.getStroke().type);
					});
				}
			});
			this.select(
				border, 'Style', stroke.type, LINE_STYLE_OPTIONS, value => mutate(current => {
					const target = freshTarget(current);
					target.setStroke(target.getStroke().width, value);
				}));
			this.color(
				border, 'Color', strokeTarget.getStrokeColorOverride?.(),
				hex => mutate(current => freshTarget(current).setStrokeColor(...this.rgb(hex)))
			);
		}
		if (strokeTarget && typeof strokeTarget.getFill === 'function' && strokeTarget.name !== 'bezier') {
			const fill = this.section('Fill');
			this.select(
				fill, 'Type', strokeTarget.getFill(), FILL_TYPE_OPTIONS,
				value => mutate(current => freshTarget(current).setFill(value))
			);
			this.color(
				fill, 'Color', strokeTarget.getFillColorOverride?.(),
				hex => mutate(current => freshTarget(current).setFillColor(...this.rgb(hex)))
			);
		}
		if (isRuleArea) {
			const ruleArea = this.section('Rule Area');
			this.check(
				ruleArea, 'Do Not Populate', !!element.isDnp?.(), value => mutate(current => current.setDnp(value)));
			this.check(
				ruleArea, 'Exclude From Simulation', !!element.isExcludedFromSim?.(),
				value => mutate(current => current.setExcludedFromSim(value))
			);
			this.check(
				ruleArea, 'Exclude From BOM', !element.isInBom?.(),
				value => mutate(current => current.setInBom(!value))
			);
			this.check(
				ruleArea, 'Exclude From Board', !element.isOnBoard?.(),
				value => mutate(current => current.setOnBoard(!value))
			);
		}
	}

	renderWireBus(element: any, kind: string, id: string): void {
		this.clear();
		const mutate = this.elementMutator(id);
		const basic = this.section('Basic Properties');
		this.row(
			basic, 'Object',
			`${ kind === 'bus' ? 'Bus' : (typeof element.getSize === 'function' ? 'Bus Entry' : 'Wire') } (${ id.slice(
				0, 8) })`
		);
		const line = this.section('Line');
		const stroke = element.getStroke();
		this.row(line, 'Width (mm)', stroke.width.toFixed(2), true, value => {
			const width = Number(value);
			if (Number.isFinite(width) && width >= 0) {
				mutate(
					current => current.setStroke(width, current.getStroke().type));
			}
		});
		this.select(
			line, 'Style', stroke.type, LINE_STYLE_OPTIONS,
			value => mutate(current => current.setStroke(current.getStroke().width, value))
		);
		this.color(
			line, 'Color', element.getStrokeColorOverride?.(),
			hex => mutate(current => current.setStrokeColor(...this.rgb(hex)))
		);
	}

	renderJunction(junction: any, id: string): void {
		this.clear();
		const mutate = this.elementMutator(id);
		const basic = this.section('Basic Properties');
		this.row(basic, 'Object', `Junction (${ id.slice(0, 8) })`);
		const props = this.section('Junction');
		this.row(
			props, 'Diameter (mm)', junction.getDiameter().toFixed(2), true, value => {
				const diameter = Number(value);
				if (Number.isFinite(diameter) && diameter >= 0) {
					mutate(current => current.setDiameter(diameter));
				}
			});
		this.color(
			props, 'Color', junction.getColorOverride?.(),
			hex => mutate(current => current.setColor(...this.rgb(hex)))
		);
	}

	renderText(element: any, id: string): void {
		this.clear();
		const mutate = this.elementMutator(id);
		const isTextBox = element.name === 'text_box';
		const basic = this.section('Basic Properties');
		this.row(basic, 'Object', `${ isTextBox ? 'Text Box' : 'Text' } (${ id.slice(0, 8) })`);
		this.row(
			basic, 'Text', String(element.value ?? ''), true, value => mutate(current => { current.value = value; }));
		this.renderFont(element, mutate);
		if (isTextBox) {
			this.renderBorderAndFill(element, mutate);
		}
	}

	renderLabel(element: any, labelKind: string | undefined, id: string): void {
		this.clear();
		const mutate = this.elementMutator(id);
		const kindLabel = labelKind === 'local' ? 'Local Label' : labelKind === 'global' ? 'Global Label' :
			labelKind === 'hier' ? 'Hierarchical Label' : labelKind === 'directive' ? 'Directive Label' : 'Label';
		const basic = this.section('Basic Properties');
		this.row(basic, 'Object', `${ kindLabel } (${ id.slice(0, 8) })`);
		const elementName = typeof element.getName === 'function' ? element.getName() : String(element.value ?? '');
		this.row(basic, 'Text', elementName, true, value => {
			const session = this.session();
			if (!session?.renameLabel(id, value)) {
				return;
			}
			this.host.refreshSchematicText(session);
			this.host.refreshUndoStack();
		});
		if (labelKind === 'global' || labelKind === 'hier') {
			this.select(
				basic, 'Shape', element.getShape?.() ?? 'input', GLOBAL_HIER_SHAPE_OPTIONS, value => {
					const session = this.session();
					if (!session?.setLabelShape(id, value as KicadGlobalLabelShape)) {
						return;
					}
					this.host.refreshSchematicText(session);
					this.host.refreshUndoStack();
				});
		}
		else if (labelKind === 'directive') {
			this.select(
				basic, 'Shape', element.getShape?.() ?? 'round', DIRECTIVE_SHAPE_OPTIONS, value => {
					const session = this.session();
					if (!session?.setLabelShape(id, value as KicadDirectiveLabelShape)) {
						return;
					}
					this.host.refreshSchematicText(session);
					this.host.refreshUndoStack();
				});
			this.row(
				basic, 'Pin Length (mm)', Number(element.getPinLength?.() ?? 2.54).toFixed(2), true, value => {
					const length = Number(value);
					if (Number.isFinite(length) && length >= 0) {
						mutate(current => current.setPinLength(length));
					}
				});
		}
		this.renderFont(element, mutate);
	}

	renderMulti(name: string, elements: any[], ids: string[]): void {
		this.clear();
		const mutate = this.elementsMutator(ids);
		const first = elements[0];
		const basic = this.section('Basic Properties');
		this.row(basic, 'Object', `${ elements.length } × ${ name }`);
		if (name === 'wire' || name === 'bus' || name === 'bus_entry') {
			this.renderLine(first, mutate);
			return;
		}
		if (name === 'junction') {
			const props = this.section('Junction');
			this.row(
				props, 'Diameter (mm)', first.getDiameter().toFixed(2), true, value => {
					const diameter = Number(value);
					if (Number.isFinite(diameter) && diameter >= 0) {
						mutate(current => current.setDiameter(diameter));
					}
				});
			this.color(
				props, 'Color', first.getColorOverride?.(),
				hex => mutate(current => current.setColor(...this.rgb(hex)))
			);
			return;
		}
		if (name === 'text' || name === 'text_box') {
			this.renderFont(first, mutate);
			if (name === 'text_box') {
				this.renderBorderAndFill(first, mutate);
			}
			return;
		}
		const isRuleArea = name === 'rule_area';
		const strokeOf = (element: any) => isRuleArea ? element.getPolyline() : element;
		const strokeTarget = strokeOf(first);
		if (strokeTarget && typeof strokeTarget.getStroke === 'function') {
			this.renderStroke(
				strokeTarget, strokeOf, mutate);
		}
		if (name !== 'bezier' && strokeTarget && typeof strokeTarget.getFill === 'function') {
			const fill = this.section('Fill');
			this.select(
				fill, 'Type', strokeTarget.getFill(), FILL_TYPE_OPTIONS,
				value => mutate(current => strokeOf(current).setFill(value))
			);
			this.color(
				fill, 'Color', strokeTarget.getFillColorOverride?.(),
				hex => mutate(current => strokeOf(current).setFillColor(...this.rgb(hex)))
			);
		}
		if (isRuleArea) {
			const ruleArea = this.section('Rule Area');
			this.check(
				ruleArea, 'Do Not Populate', !!first.isDnp?.(), value => mutate(current => current.setDnp(value)));
			this.check(
				ruleArea, 'Exclude From Simulation', !!first.isExcludedFromSim?.(),
				value => mutate(current => current.setExcludedFromSim(value))
			);
			this.check(
				ruleArea, 'Exclude From BOM', !first.isInBom?.(), value => mutate(current => current.setInBom(!value)));
			this.check(
				ruleArea, 'Exclude From Board', !first.isOnBoard?.(),
				value => mutate(current => current.setOnBoard(!value))
			);
		}
	}

	protected renderLine(element: any, mutate: (fn: (element: any) => void) => void): void {
		const line = this.section('Line');
		const stroke = element.getStroke();
		this.row(line, 'Width (mm)', stroke.width.toFixed(2), true, value => {
			const width = Number(value);
			if (Number.isFinite(width) && width >= 0) {
				mutate(
					current => current.setStroke(width, current.getStroke().type));
			}
		});
		this.select(
			line, 'Style', stroke.type, LINE_STYLE_OPTIONS,
			value => mutate(current => current.setStroke(current.getStroke().width, value))
		);
		this.color(
			line, 'Color', element.getStrokeColorOverride?.(),
			hex => mutate(current => current.setStrokeColor(...this.rgb(hex)))
		);
	}

	protected renderStroke(
		element: any, strokeOf: (element: any) => any, mutate: (fn: (element: any) => void) => void): void {
		const border = this.section('Border');
		const stroke = element.getStroke();
		this.row(border, 'Width (mm)', stroke.width.toFixed(2), true, value => {
			const width = Number(value);
			if (Number.isFinite(width) && width >= 0) {
				mutate(current => {
					const target = strokeOf(current);
					target.setStroke(width, target.getStroke().type);
				});
			}
		});
		this.select(
			border, 'Style', stroke.type, LINE_STYLE_OPTIONS, value => mutate(current => {
				const target = strokeOf(current);
				target.setStroke(target.getStroke().width, value);
			}));
		this.color(
			border, 'Color', element.getStrokeColorOverride?.(),
			hex => mutate(current => strokeOf(current).setStrokeColor(...this.rgb(hex)))
		);
	}

	protected renderFont(element: any, mutate: (fn: (element: any) => void) => void): void {
		const font = this.section('Font');
		const info = typeof element.getFont === 'function' ? element.getFont() :
			{ width: 1.27, height: 1.27, bold: false, italic: false, thickness: undefined };
		this.row(font, 'Size (mm)', (info.height || 1.27).toFixed(2), true, value => {
			const size = Number(value);
			if (Number.isFinite(size) && size > 0) {
				mutate(current => {
					const f = current.getFont();
					current.setFont(size, size, f.italic, f.bold, f.thickness);
				});
			}
		});
		this.check(font, 'Bold', !!info.bold, value => mutate(current => {
			const f = current.getFont();
			current.setFont(f.width || 1.27, f.height || 1.27, f.italic, value, f.thickness);
		}));
		this.check(font, 'Italic', !!info.italic, value => mutate(current => {
			const f = current.getFont();
			current.setFont(f.width || 1.27, f.height || 1.27, value, f.bold, f.thickness);
		}));
		this.color(
			font, 'Color', element.getFontColorOverride?.(),
			hex => mutate(current => current.setFontColor(...this.rgb(hex)))
		);
	}

	protected renderBorderAndFill(
		element: any, mutate: (fn: (element: any) => void) => void): void {
		const border = this.section('Border');
		const stroke = element.getStroke();
		this.row(border, 'Width (mm)', stroke.width.toFixed(2), true, value => {
			const width = Number(value);
			if (Number.isFinite(width) && width >= 0) {
				mutate(
					current => current.setStroke(width, current.getStroke().type));
			}
		});
		this.select(
			border, 'Style', stroke.type, LINE_STYLE_OPTIONS,
			value => mutate(current => current.setStroke(current.getStroke().width, value))
		);
		this.color(
			border, 'Color', element.getStrokeColorOverride?.(),
			hex => mutate(current => current.setStrokeColor(...this.rgb(hex)))
		);
		const fill = this.section('Fill');
		this.select(
			fill, 'Type', element.getFill(), FILL_TYPE_OPTIONS, value => mutate(current => current.setFill(value)));
		this.color(
			fill, 'Color', element.getFillColorOverride?.(),
			hex => mutate(current => current.setFillColor(...this.rgb(hex)))
		);
	}
}
