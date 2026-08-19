import { colorForLayer } from '@kicad-render/paint/LayerColors';

export type BarcodeType = 'code39' | 'code128' | 'datamatrix' | 'qr' | 'microqr';
export type BarcodeEcc = 'L' | 'M' | 'Q' | 'H';

export interface BarcodePropertiesDraft {
	text: string;
	type: BarcodeType;
	errorCorrection: BarcodeEcc;
	showText: boolean;
	textHeightMm: number;
	widthMm: number;
	heightMm: number;
	locked: boolean;
	layer: string;
	knockout: boolean;
	marginXmm: number;
	marginYmm: number;
	positionX: number;
	positionY: number;
	orientation: number;
}

/** KiCad's Barcode Properties dialog distilled to the fields serialized by
 * PCB_BARCODE. Geometry comes from Zint, so this remains a semantic draft. */
export class BarcodePropertiesDialog {
	protected readonly element = document.createElement('div');
	protected draft: BarcodePropertiesDraft | null = null;
	protected onCommit: ((draft: BarcodePropertiesDraft) => void | string | Promise<void | string>) | null = null;
	protected validationError: string | null = null;

	constructor() {
		this.element.className = 'preferences-modal board-text-props-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				this.close();
			}
		});
		document.body.appendChild(this.element);
	}

	open(
		initial: BarcodePropertiesDraft, layers: readonly string[],
		onCommit: (draft: BarcodePropertiesDraft) => void | string | Promise<void | string>
	): void {
		this.draft = { ...initial };
		this.onCommit = onCommit;
		this.validationError = null;
		this.render(layers);
		this.element.classList.remove('hidden');
		window.setTimeout(() => this.element.querySelector<HTMLInputElement>('input[name="barcode-text"]')?.focus(), 0);
	}

	protected close(): void {
		this.element.classList.add('hidden');
		this.draft = null;
		this.onCommit = null;
		this.validationError = null;
	}

	protected render(layers: readonly string[]): void {
		const draft = this.draft;
		if (!draft) {
			return;
		}
		const title = document.createElement('div');
		title.className = 'preferences-titlebar';
		const heading = document.createElement('h2');
		heading.textContent = 'Barcode Properties';
		const close = this.button('×', () => this.close());
		close.className = 'preferences-close';
		close.setAttribute('aria-label', 'Close barcode properties');
		title.append(heading, close);

		const body = document.createElement('div');
		body.className = 'board-text-props-body';
		body.append(this.field('Text:', this.textInput(draft.text, value => { draft.text = value; }, 'barcode-text')));
		const barcode = document.createElement('div');
		barcode.className = 'board-text-props-basics';
		barcode.append(
			this.field(
				'Type:', this.select(draft.type, [
					['code39', 'Code 39'], ['code128', 'Code 128'], ['qr', 'QR Code'], ['microqr', 'Micro QR Code'],
					['datamatrix', 'Data Matrix']
				], value => {
					draft.type = value as BarcodeType;
					if (draft.type === 'microqr' && draft.errorCorrection === 'H') {
						draft.errorCorrection = 'Q';
					}
					this.render(layers);
				})),
			this.field(
				'Error correction:', this.select(
					draft.errorCorrection,
					[['L', 'L (Low)'], ['M', 'M (Medium)'], ['Q', 'Q (Quartile)'], ['H', 'H (High)']],
					value => { draft.errorCorrection = value as BarcodeEcc; }
				))
		);
		const ecc = barcode.lastElementChild?.querySelector('select') as HTMLSelectElement | null;
		if (ecc) {
			ecc.disabled = draft.type !== 'qr' && draft.type !== 'microqr';
			const highEcc = ecc.querySelector('option[value="H"]') as HTMLOptionElement | null;
			if (highEcc) {
				highEcc.disabled = draft.type === 'microqr';
			}
		}

		const appearance = document.createElement('div');
		appearance.className = 'board-text-props-metrics';
		appearance.append(
			this.field('Width:', this.number(draft.widthMm, value => { draft.widthMm = value; }), 'mm'),
			this.field('Height:', this.number(draft.heightMm, value => { draft.heightMm = value; }), 'mm'),
			this.field('Text height:', this.number(draft.textHeightMm, value => { draft.textHeightMm = value; }), 'mm'),
			this.checkbox('Show text', draft.showText, value => { draft.showText = value; })
		);
		const marginX = this.number(draft.marginXmm, value => { draft.marginXmm = value; });
		marginX.name = 'barcode-margin-x';
		const marginY = this.number(draft.marginYmm, value => { draft.marginYmm = value; });
		marginY.name = 'barcode-margin-y';
		const location = document.createElement('div');
		location.className = 'board-text-props-position';
		location.append(
			this.field('Layer:', this.layerSelect(draft, layers)),
			this.checkbox('Locked', draft.locked, value => { draft.locked = value; }),
			this.checkbox('Knockout', draft.knockout, value => {
				draft.knockout = value;
				this.render(layers);
			}),
			this.field('Margin X:', marginX, 'mm'),
			this.field('Margin Y:', marginY, 'mm'),
			this.field('Position X:', this.number(draft.positionX, value => { draft.positionX = value; }), 'mm'),
			this.field('Position Y:', this.number(draft.positionY, value => { draft.positionY = value; }), 'mm'),
			this.field(
				'Orientation:', this.number(draft.orientation, value => { draft.orientation = value; }, '1'), '°')
		);
		marginX.disabled = !draft.knockout;
		marginY.disabled = !draft.knockout;
		body.append(barcode, appearance, location);
		if (this.validationError) {
			const error = document.createElement('p');
			error.className = 'board-text-props-error';
			error.textContent = this.validationError;
			body.append(error);
		}
		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		footer.append(spacer, this.button('Cancel', () => this.close()), this.button('OK', async () => {
			if (!this.draft?.text.trim() || !this.onCommit) {
				return;
			}
			const validationError = await this.onCommit({ ...this.draft });
			if (typeof validationError === 'string') {
				this.validationError = validationError;
				this.render(layers);
				return;
			}
			this.close();
		}));
		this.element.replaceChildren(title, body, footer);
	}

	protected field(
		label: string, control: HTMLElement, unit?: string): HTMLElement {
		const row = document.createElement('label');
		row.className = 'board-text-props-field';
		const caption = document.createElement('span');
		caption.textContent = label;
		row.append(caption, control);
		if (unit) {
			const suffix = document.createElement('span');
			suffix.className = 'board-text-props-unit';
			suffix.textContent = unit;
			row.append(suffix);
		}
		return row;
	}

	protected textInput(
		value: string, onChange: (value: string) => void, name: string): HTMLInputElement {
		const input = document.createElement('input');
		input.name = name;
		input.value = value;
		input.addEventListener('input', () => onChange(input.value));
		return input;
	}

	protected number(
		value: number, onChange: (value: number) => void, step = '0.01'): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '0';
		input.step = step;
		input.value = String(value);
		input.addEventListener('input', () => onChange(Number(input.value) || 0));
		return input;
	}

	protected select(
		value: string, options: [string, string][], onChange: (value: string) => void): HTMLSelectElement {
		const select = document.createElement('select');
		for (const [optionValue, label] of options) {
			select.append(
				new Option(label, optionValue, false, optionValue === value));
		}
		select.addEventListener('change', () => onChange(select.value));
		return select;
	}

	protected checkbox(
		label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
		const row = document.createElement('label');
		row.className = 'preferences-check';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.addEventListener('change', () => onChange(input.checked));
		row.append(input, ` ${ label }`);
		return row;
	}

	protected layerSelect(
		draft: BarcodePropertiesDraft, layers: readonly string[]): HTMLElement {
		const wrap = document.createElement('div');
		wrap.className = 'board-text-props-layer-select';
		const swatch = document.createElement('span');
		swatch.className = 'board-text-props-layer-swatch';
		swatch.style.background = colorForLayer(draft.layer);
		const select = this.select(draft.layer, layers.map(layer => [layer, layer]), value => {
			draft.layer = value;
			swatch.style.background = colorForLayer(value);
		});
		wrap.append(swatch, select);
		return wrap;
	}

	protected button(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}
}
