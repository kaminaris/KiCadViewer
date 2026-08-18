import type { PolygonDraft } from '@kicad-render/KicadRenderSession';
import { colorForLayer } from '@kicad-render/paint/LayerColors';
import type { GrShapeFillMode } from '@kicad-io/KicadElementPolygon';
import type { KicadStrokeType } from '@kicad-io/KicadElementStroke';

export interface PolygonPropertiesDialogCallbacks {
	getLayers(): string[];
	isCopperLayer(layer: string): boolean;
}

/** KiCad's DIALOG_SHAPE_PROPERTIES hides its geometry notebook entirely for
 * SHAPE_T::POLY ("Nothing to do here...yet") — vertex editing is the point
 * editor's job — leaving just line width/style, fill, locked, net and layer.
 * See PolygonDraft's own doc comment for the full field-by-field source. */
export class PolygonPropertiesDialog {
	protected readonly element = document.createElement('div');
	protected draft: PolygonDraft = PolygonPropertiesDialog.blankDraft();
	protected onCommit: ((draft: PolygonDraft) => void) | null = null;

	constructor(protected readonly callbacks: PolygonPropertiesDialogCallbacks) {
		this.element.className = 'preferences-modal polygon-props-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-labelledby', 'polygon-props-title');
		this.element.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			}
		});
		document.body.appendChild(this.element);
	}

	static blankDraft(): PolygonDraft {
		return { layer: '', lineWidthMm: 0.1, lineStyle: 'default', fillMode: 'no', locked: false, netName: '' };
	}

	open(initial: PolygonDraft, onCommit: (draft: PolygonDraft) => void): void {
		this.draft = { ...initial };
		this.onCommit = onCommit;
		this.render();
		this.element.classList.remove('hidden');
	}

	protected close(): void {
		this.element.classList.add('hidden');
		this.onCommit = null;
	}

	protected render(): void {
		const draft = this.draft;
		const title = document.createElement('div');
		title.className = 'preferences-titlebar';
		const heading = document.createElement('h2');
		heading.id = 'polygon-props-title';
		heading.textContent = 'Polygon Properties';
		const close = this.button('×', () => this.close());
		close.className = 'preferences-close';
		close.setAttribute('aria-label', 'Close polygon properties');
		title.append(heading, close);

		const body = document.createElement('div');
		body.className = 'polygon-props-body';
		body.append(
			this.field('Line width:', this.numberInput(draft.lineWidthMm, value => { draft.lineWidthMm = value; }), 'mm'),
			this.field('Line style:', this.strokeStyleSelect(draft)),
			this.field('Fill:', this.fillSelect(draft)),
			this.field('Layer:', this.layerSelect(draft))
		);
		const isCopper = this.callbacks.isCopperLayer(draft.layer);
		const netRow = this.field('Net:', this.textInput(draft.netName, value => { draft.netName = value; }));
		if (!isCopper) {
			netRow.classList.add('polygon-props-field-disabled');
			netRow.querySelector('input')!.disabled = true;
		}
		body.append(netRow, this.checkbox('Locked', draft.locked, value => { draft.locked = value; }));

		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		footer.append(spacer, this.button('Cancel', () => this.close()), this.button('OK', () => {
			if (!this.onCommit || !draft.layer) return;
			this.onCommit({ ...draft });
			this.close();
		}));

		this.element.replaceChildren(title, body, footer);
	}

	protected layerSelect(draft: PolygonDraft): HTMLElement {
		const wrap = document.createElement('div');
		wrap.className = 'board-text-props-layer-select';
		const swatch = document.createElement('span');
		swatch.className = 'board-text-props-layer-swatch';
		swatch.style.background = colorForLayer(draft.layer);
		const select = document.createElement('select');
		const layers = this.callbacks.getLayers();
		for (const layer of layers) {
			select.appendChild(new Option(layer, layer, false, layer === draft.layer));
		}
		if (!layers.includes(draft.layer) && draft.layer) {
			select.appendChild(new Option(draft.layer, draft.layer, false, true));
		}
		select.addEventListener('change', () => {
			draft.layer = select.value;
			swatch.style.background = colorForLayer(draft.layer);
			this.render();
		});
		wrap.append(swatch, select);
		return wrap;
	}

	protected strokeStyleSelect(draft: PolygonDraft): HTMLSelectElement {
		return this.selectField<KicadStrokeType>(draft.lineStyle, [
			['default', 'Default'], ['solid', 'Solid'], ['dash', 'Dashed'],
			['dot', 'Dotted'], ['dash_dot', 'Dash-Dot'], ['dash_dot_dot', 'Dash-Dot-Dot']
		], value => { draft.lineStyle = value; });
	}

	protected fillSelect(draft: PolygonDraft): HTMLSelectElement {
		return this.selectField<GrShapeFillMode>(draft.fillMode, [
			['no', 'None'], ['yes', 'Solid'], ['hatch', 'Hatch'],
			['reverse_hatch', 'Reverse Hatch'], ['cross_hatch', 'Cross-hatch']
		], value => { draft.fillMode = value; });
	}

	protected selectField<T extends string>(value: T, options: [T, string][], onChange: (value: T) => void): HTMLSelectElement {
		const select = document.createElement('select');
		for (const [optionValue, label] of options) {
			select.appendChild(new Option(label, optionValue, false, optionValue === value));
		}
		select.addEventListener('change', () => onChange(select.value as T));
		return select;
	}

	protected field(label: string, control: HTMLElement, unit?: string): HTMLElement {
		const row = document.createElement('label');
		row.className = 'board-text-props-field';
		const caption = document.createElement('span');
		caption.textContent = label;
		row.append(caption, control);
		if (unit) {
			const unitEl = document.createElement('span');
			unitEl.className = 'board-text-props-unit';
			unitEl.textContent = unit;
			row.appendChild(unitEl);
		}
		return row;
	}

	protected textInput(value: string, onChange: (value: string) => void): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'text';
		input.value = value;
		input.addEventListener('input', () => onChange(input.value));
		return input;
	}

	protected numberInput(value: number, onChange: (value: number) => void): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '0';
		input.step = '0.01';
		input.value = String(value);
		input.addEventListener('input', () => onChange(Number(input.value) || 0));
		return input;
	}

	protected checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
		const row = document.createElement('label');
		row.className = 'preferences-check';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.addEventListener('change', () => onChange(input.checked));
		row.append(input, ` ${ label }`);
		return row;
	}

	protected button(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}
}
