import { colorForLayer } from '@kicad-render/paint/LayerColors';

export type BoardTextHorizontalAlignment = 'left' | 'middle' | 'right';
export type BoardTextVerticalAlignment = 'top' | 'middle' | 'bottom';

export interface BoardTextPropertiesDraft {
	isTextBox: boolean;
	text: string;
	locked: boolean;
	layer: string;
	knockout: boolean;
	widthMm: number;
	heightMm: number;
	thicknessMm: number;
	bold: boolean;
	italic: boolean;
	horizontalAlignment: BoardTextHorizontalAlignment;
	verticalAlignment: BoardTextVerticalAlignment;
	mirrored: boolean;
	positionX: number;
	positionY: number;
	orientation: number;
	border: boolean;
	borderWidthMm: number;
	borderStyle: string;
}

/** KiCad's board Text Properties dialog, for both free board text and
 * footprint text. The draft is intentionally independent of the AST so
 * Cancel is genuinely non-mutating and OK applies every field atomically. */
export class BoardTextPropertiesDialog {
	protected readonly element = document.createElement('div');
	protected draft: BoardTextPropertiesDraft | null = null;
	protected onCommit: ((draft: BoardTextPropertiesDraft) => void) | null = null;
	protected linkedSize = true;

	constructor() {
		this.element.className = 'preferences-modal board-text-props-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-labelledby', 'board-text-props-title');
		this.element.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			}
		});
		document.body.appendChild(this.element);
	}

	open(
		initial: BoardTextPropertiesDraft, layers: readonly string[],
		onCommit: (draft: BoardTextPropertiesDraft) => void
	): void {
		this.draft = { ...initial };
		this.onCommit = onCommit;
		this.linkedSize = initial.widthMm === initial.heightMm;
		this.render(layers);
		this.element.classList.remove('hidden');
		window.setTimeout(() => this.element.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 0);
	}

	protected close(): void {
		this.element.classList.add('hidden');
		this.draft = null;
		this.onCommit = null;
	}

	protected render(layers: readonly string[]): void {
		const draft = this.draft;
		if (!draft) {
			return;
		}

		const title = document.createElement('div');
		title.className = 'preferences-titlebar';
		const heading = document.createElement('h2');
		heading.id = 'board-text-props-title';
		heading.textContent = draft.isTextBox ? 'Text Box Properties' : 'Text Properties';
		const close = this.button('×', () => this.close());
		close.className = 'preferences-close';
		close.setAttribute('aria-label', 'Close text properties');
		title.append(heading, close);

		const body = document.createElement('div');
		body.className = 'board-text-props-body';
		const textLabel = document.createElement('label');
		textLabel.className = 'board-text-props-text-label';
		textLabel.textContent = 'Text:';
		const text = document.createElement('textarea');
		text.value = draft.text;
		text.rows = 5;
		text.addEventListener('input', () => { draft.text = text.value; });
		const syntaxHelp = document.createElement('a');
		syntaxHelp.className = 'board-text-props-syntax-help';
		syntaxHelp.href = 'https://docs.kicad.org/';
		syntaxHelp.target = '_blank';
		syntaxHelp.rel = 'noreferrer';
		syntaxHelp.textContent = 'Syntax help';

		const basics = document.createElement('div');
		basics.className = 'board-text-props-basics';
		basics.append(
			this.checkbox('Locked', draft.locked, value => { draft.locked = value; }),
			this.field('Layer:', this.layerSelect(draft, layers))
		);
		if (!draft.isTextBox) {
			basics.append(this.checkbox('Knockout', draft.knockout, value => { draft.knockout = value; }));
		}

		const font = document.createElement('div');
		font.className = 'board-text-props-font';
		const fontSelect = document.createElement('select');
		fontSelect.disabled = true;
		fontSelect.appendChild(new Option('KiCad Font', 'kicad-font', true, true));
		const styleButtons = document.createElement('div');
		styleButtons.className = 'board-text-props-style-buttons';
		styleButtons.append(
			this.toggleButton('B', 'Bold', draft.bold, value => { draft.bold = value; }),
			this.toggleButton('I', 'Italic', draft.italic, value => { draft.italic = value; }),
			this.alignmentButton(
				'≡', 'Align left', draft.horizontalAlignment === 'left', () => {
					draft.horizontalAlignment = 'left';
					this.render(layers);
				}),
			this.alignmentButton(
				'≡', 'Align centre', draft.horizontalAlignment === 'middle', () => {
					draft.horizontalAlignment = 'middle';
					this.render(layers);
				}),
			this.alignmentButton(
				'≡', 'Align right', draft.horizontalAlignment === 'right', () => {
					draft.horizontalAlignment = 'right';
					this.render(layers);
				}),
			this.alignmentButton(
				'↥', 'Align top', draft.verticalAlignment === 'top', () => {
					draft.verticalAlignment = 'top';
					this.render(layers);
				}),
			this.alignmentButton(
				'↕', 'Align middle', draft.verticalAlignment === 'middle', () => {
					draft.verticalAlignment = 'middle';
					this.render(layers);
				}),
			this.alignmentButton(
				'↧', 'Align bottom', draft.verticalAlignment === 'bottom', () => {
					draft.verticalAlignment = 'bottom';
					this.render(layers);
				}),
			this.toggleButton('↔', 'Mirror text', draft.mirrored, value => { draft.mirrored = value; })
		);
		font.append(this.field('Font:', fontSelect), styleButtons);

		const metrics = document.createElement('div');
		metrics.className = 'board-text-props-metrics';
		const widthInput = this.numberInput(draft.widthMm, value => {
			draft.widthMm = value;
			if (this.linkedSize) {
				draft.heightMm = value;
				this.syncLinkedDimension('height', value);
			}
		});
		widthInput.dataset.textDimension = 'width';
		const heightInput = this.numberInput(draft.heightMm, value => {
			draft.heightMm = value;
			if (this.linkedSize) {
				draft.widthMm = value;
				this.syncLinkedDimension('width', value);
			}
		});
		heightInput.dataset.textDimension = 'height';
		metrics.append(
			this.field('Width:', widthInput, 'mm'),
			this.field('Height:', heightInput, 'mm'),
			this.field(
				'Thickness:', this.numberInput(draft.thicknessMm, value => { draft.thicknessMm = value; }), 'mm'),
			this.linkSizeToggle()
		);
		const geometry = document.createElement('div');
		geometry.className = 'board-text-props-position';
		if (draft.isTextBox) {
			geometry.append(
				this.checkbox('Border', draft.border, value => {
					draft.border = value;
					this.render(layers);
				}),
				this.field(
					'Border width:', this.numberInput(draft.borderWidthMm, value => { draft.borderWidthMm = value; }),
					'mm'
				),
				this.field('Border style:', this.strokeStyleSelect(draft))
			);
			for (const input of Array.from(
				geometry.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'))) {
				input.disabled = !draft.border;
			}
		}
		else {
			geometry.append(
				this.field(
					'Position X:', this.numberInput(draft.positionX, value => { draft.positionX = value; }), 'mm'),
				this.field(
					'Position Y:', this.numberInput(draft.positionY, value => { draft.positionY = value; }), 'mm')
			);
		}
		geometry.append(this.field(
			'Orientation:',
			this.numberInput(draft.orientation, value => { draft.orientation = value; }, '1'), '°'
		));

		body.append(textLabel, text, syntaxHelp, basics, font, metrics, geometry);
		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		footer.append(spacer, this.button('Cancel', () => this.close()), this.button('OK', () => {
			if (!this.draft || !this.onCommit || !this.draft.text.trim()) {
				return;
			}
			this.onCommit({ ...this.draft });
			this.close();
		}));
		this.element.replaceChildren(title, body, footer);
	}

	protected layerSelect(draft: BoardTextPropertiesDraft, layers: readonly string[]): HTMLElement {
		const wrap = document.createElement('div');
		wrap.className = 'board-text-props-layer-select';
		const swatch = document.createElement('span');
		swatch.className = 'board-text-props-layer-swatch';
		swatch.style.background = colorForLayer(draft.layer);
		const select = document.createElement('select');
		for (const layer of layers) {
			select.appendChild(new Option(layer, layer, false, layer === draft.layer));
		}
		if (!layers.includes(draft.layer)) {
			select.appendChild(new Option(draft.layer || 'F.Cu', draft.layer || 'F.Cu', false, true));
		}
		select.addEventListener('change', () => {
			draft.layer = select.value;
			swatch.style.background = colorForLayer(draft.layer);
		});
		wrap.append(swatch, select);
		return wrap;
	}

	protected strokeStyleSelect(draft: BoardTextPropertiesDraft): HTMLSelectElement {
		const select = document.createElement('select');
		for (const [value, label] of [
			['default', 'Default'], ['solid', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted'],
			['dash_dot', 'Dash-dot'], ['dash_dot_dot', 'Dash-dot-dot']
		]) {
			select.appendChild(new Option(label, value, false, value === draft.borderStyle));
		}
		select.addEventListener('change', () => { draft.borderStyle = select.value; });
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

	protected numberInput(value: number, onChange: (value: number) => void, step = '0.01'): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '0';
		input.step = step;
		input.value = String(value);
		input.addEventListener('input', () => onChange(Number(input.value) || 0));
		return input;
	}

	protected checkbox(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
		const row = document.createElement('label');
		row.className = 'preferences-check';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.addEventListener('change', () => onChange(input.checked));
		row.append(input, ` ${ label }`);
		return row;
	}

	protected toggleButton(
		label: string, title: string, checked: boolean, onChange: (value: boolean) => void): HTMLButtonElement {
		const button = this.button(label, () => {
			const next = !button.classList.contains('active');
			onChange(next);
			button.classList.toggle('active');
			button.setAttribute('aria-pressed', String(next));
		});
		button.className = `board-text-props-icon-button${ checked ? ' active' : '' }`;
		button.title = title;
		button.setAttribute('aria-label', title);
		button.setAttribute('aria-pressed', String(checked));
		return button;
	}

	protected alignmentButton(label: string, title: string, checked: boolean, onClick: () => void): HTMLButtonElement {
		const button = this.button(label, onClick);
		button.className = `board-text-props-icon-button board-text-props-align-${ title.split(' ')
			.at(-1)
			?.toLowerCase() }${ checked ? ' active' : '' }`;
		button.title = title;
		button.setAttribute('aria-label', title);
		button.setAttribute('aria-pressed', String(checked));
		return button;
	}

	protected linkSizeToggle(): HTMLButtonElement {
		const button = this.button(this.linkedSize ? '⛓' : '⛓', () => {
			this.linkedSize = !this.linkedSize;
			button.classList.toggle('active', this.linkedSize);
			button.setAttribute('aria-pressed', String(this.linkedSize));
		});
		button.className = `board-text-props-link-size${ this.linkedSize ? ' active' : '' }`;
		button.title = 'Link width and height';
		button.setAttribute('aria-label', 'Link width and height');
		button.setAttribute('aria-pressed', String(this.linkedSize));
		return button;
	}

	protected syncLinkedDimension(dimension: 'width' | 'height', value: number): void {
		const input = this.element.querySelector<HTMLInputElement>(`input[data-text-dimension="${ dimension }"]`);
		if (input && document.activeElement !== input) {
			input.value = String(value);
		}
	}

	protected button(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}
}
