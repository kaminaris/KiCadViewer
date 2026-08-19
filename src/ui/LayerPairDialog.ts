export interface LayerPairDialogCallbacks {
	getBoardCopperLayers(): string[];

	getViaLayerPair(): [string, string];

	setViaLayerPair(pair: [string, string]): void;
}

/** Real KiCad's "Select Layer Pair" dialog — which two copper layers a
 *  newly placed via spans. Reuses the Preferences modal's `.preferences-*`
 *  shell classes, the same established precedent RouterSettingsDialog.ts
 *  already follows for a similarly small, rarely-opened settings modal —
 *  no new CSS needed. */
export class LayerPairDialog {
	protected readonly element = document.createElement('div');
	protected fromLayer = 'F.Cu';
	protected toLayer = 'B.Cu';

	constructor(protected readonly callbacks: LayerPairDialogCallbacks) {
		this.element.className = 'preferences-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-labelledby', 'layer-pair-title');
		document.body.appendChild(this.element);
	}

	open(): void {
		[this.fromLayer, this.toLayer] = this.callbacks.getViaLayerPair();
		this.render();
		this.element.classList.remove('hidden');
	}

	protected close(): void {
		this.element.classList.add('hidden');
	}

	protected render(): void {
		const title = document.createElement('div');
		title.className = 'preferences-titlebar';
		const heading = document.createElement('h2');
		heading.id = 'layer-pair-title';
		heading.textContent = 'Select Layer Pair';
		const closeBtn = this.button('×', () => this.close());
		closeBtn.className = 'preferences-close';
		closeBtn.setAttribute('aria-label', 'Close layer pair dialog');
		title.append(heading, closeBtn);

		const layers = this.callbacks.getBoardCopperLayers();
		const body = document.createElement('div');
		body.className = 'preferences-page';
		body.append(
			this.layerField('New vias span from:', this.fromLayer, layers, layer => { this.fromLayer = layer; }),
			this.layerField('…to:', this.toLayer, layers, layer => { this.toLayer = layer; })
		);

		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		footer.append(
			spacer, this.button('Cancel', () => this.close()),
			this.button('OK', () => {
				if (this.fromLayer !== this.toLayer) {
					this.callbacks.setViaLayerPair([this.fromLayer, this.toLayer]);
				}
				this.close();
			})
		);

		this.element.replaceChildren(title, body, footer);
	}

	protected layerField(
		label: string, value: string, layers: string[], onChange: (layer: string) => void): HTMLElement {
		const field = document.createElement('label');
		field.className = 'preferences-field';
		field.append(label);
		const select = document.createElement('select');
		for (const layer of layers) {
			select.appendChild(new Option(layer, layer, false, layer === value));
		}
		select.addEventListener('change', () => onChange(select.value));
		field.appendChild(select);
		return field;
	}

	protected button(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}
}
