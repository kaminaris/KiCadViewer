import type { RuleAreaDraft } from '@kicad-render/KicadRenderSession';
import { colorForLayer } from '@kicad-render/paint/LayerColors';
import type { ZoneHatchStyle } from '@kicad-io/KicadElementZone';

export interface RuleAreaPropertiesDialogCallbacks {
	getLayers(): string[];
}

type Tab = 'keepouts' | 'placement';

/** PCB rule areas are authored as zones, but KiCad gives their keepout and
 * placement settings a dedicated dialog. This intentionally shares the
 * zone-dialog shell and layer picker without exposing copper-only controls. */
export class RuleAreaPropertiesDialog {
	protected readonly element = document.createElement('div');
	protected draft: RuleAreaDraft = RuleAreaPropertiesDialog.blankDraft();
	protected activeTab: Tab = 'keepouts';
	protected onCommit: ((draft: RuleAreaDraft) => void) | null = null;

	constructor(protected readonly callbacks: RuleAreaPropertiesDialogCallbacks) {
		this.element.className = 'preferences-modal zone-props-modal rule-area-props-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-labelledby', 'rule-area-props-title');
		document.body.appendChild(this.element);
	}

	static blankDraft(): RuleAreaDraft {
		return {
			layers: [], name: '', locked: false, hatchStyle: 'edge', hatchPitchMm: 0.5,
			keepout: { tracks: true, vias: true, pads: true, zoneFills: false, footprints: false }
		};
	}

	open(initial: RuleAreaDraft, onCommit: (draft: RuleAreaDraft) => void): void {
		this.draft = { ...initial, layers: [...initial.layers], keepout: { ...initial.keepout } };
		this.onCommit = onCommit;
		this.activeTab = 'keepouts';
		this.render();
		this.element.classList.remove('hidden');
	}

	protected close(): void {
		this.element.classList.add('hidden');
		this.onCommit = null;
	}

	protected render(): void {
		const title = document.createElement('div');
		title.className = 'preferences-titlebar';
		const heading = document.createElement('h2');
		heading.id = 'rule-area-props-title';
		heading.textContent = 'Rule Area Properties';
		const close = this.button('×', () => this.close());
		close.className = 'preferences-close';
		close.setAttribute('aria-label', 'Close rule area properties');
		title.append(heading, close);

		const body = document.createElement('div');
		body.className = 'zone-props-body';
		body.append(this.layersColumn(), this.mainColumn());

		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const ok = this.button('OK', () => {
			if (this.draft.layers.length && this.onCommit) {
				this.onCommit(this.draft);
				this.close();
			}
		});
		ok.disabled = this.draft.layers.length === 0;
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		footer.append(spacer, this.button('Cancel', () => this.close()), ok);

		this.element.replaceChildren(title, body, footer);
	}

	protected layersColumn(): HTMLElement {
		const column = document.createElement('div');
		column.className = 'zone-props-layers';
		const heading = document.createElement('h3');
		heading.textContent = 'Layers:';
		column.appendChild(heading);
		for (const layer of this.callbacks.getLayers()) {
			const row = document.createElement('label');
			row.className = 'zone-props-layer-row';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = this.draft.layers.includes(layer);
			checkbox.addEventListener('change', () => {
				this.draft.layers = checkbox.checked ? [...this.draft.layers, layer] : this.draft.layers.filter(value => value !== layer);
				this.render();
			});
			const swatch = document.createElement('span');
			swatch.className = 'zone-props-swatch';
			swatch.style.background = colorForLayer(layer);
			const name = document.createElement('span');
			name.textContent = layer;
			row.append(checkbox, swatch, name);
			column.appendChild(row);
		}
		return column;
	}

	protected mainColumn(): HTMLElement {
		const column = document.createElement('div');
		column.className = 'zone-props-main';
		column.append(
			this.field('Area name:', this.textInput(this.draft.name, value => { this.draft.name = value; })),
			this.checkbox('Locked', this.draft.locked, value => { this.draft.locked = value; })
		);
		const tabs = document.createElement('div');
		tabs.className = 'zone-props-tabs';
		tabs.append(this.tabButton('Keepouts', 'keepouts'), this.tabButton('Placement', 'placement'));
		column.appendChild(tabs);
		const pane = document.createElement('div');
		pane.className = 'zone-props-pane';
		pane.append(this.activeTab === 'keepouts' ? this.keepoutsTab() : this.placementTab());
		column.append(
			pane,
			this.field('Outline display:', this.selectField<ZoneHatchStyle>(this.draft.hatchStyle, [
				['none', 'Line'], ['edge', 'Hatched'], ['full', 'Fully hatched']
			], value => { this.draft.hatchStyle = value; this.render(); }))
		);
		if (this.draft.hatchStyle !== 'none') {
			column.append(this.field('Outline hatch pitch:', this.numberField(
				this.draft.hatchPitchMm, value => { this.draft.hatchPitchMm = value; }), 'mm'));
		}
		return column;
	}

	protected keepoutsTab(): HTMLElement {
		const wrap = document.createElement('div');
		const keepout = this.draft.keepout;
		wrap.append(
			this.checkbox('Keep out tracks', keepout.tracks, value => { keepout.tracks = value; }),
			this.checkbox('Keep out vias', keepout.vias, value => { keepout.vias = value; }),
			this.checkbox('Keep out pads', keepout.pads, value => { keepout.pads = value; }),
			this.checkbox('Keep out zone fills', keepout.zoneFills, value => { keepout.zoneFills = value; }),
			this.checkbox('Keep out footprints', keepout.footprints, value => { keepout.footprints = value; })
		);
		return wrap;
	}

	protected placementTab(): HTMLElement {
		const wrap = document.createElement('div');
		wrap.className = 'rule-area-placement-placeholder';
		wrap.textContent = 'Placement rule areas are not available in KiOnline yet.';
		return wrap;
	}

	protected tabButton(label: string, tab: Tab): HTMLButtonElement {
		const button = this.button(label, () => { this.activeTab = tab; this.render(); });
		button.className = `zone-props-tab${ this.activeTab === tab ? ' active' : '' }`;
		return button;
	}

	protected field(label: string, control: HTMLElement, unit?: string): HTMLElement {
		const row = document.createElement('label');
		row.className = 'zone-props-field';
		const caption = document.createElement('span');
		caption.textContent = label;
		row.append(caption, control);
		if (unit) {
			const unitEl = document.createElement('span');
			unitEl.className = 'zone-props-unit';
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

	protected numberField(value: number, onChange: (value: number) => void): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '0';
		input.step = '0.01';
		input.value = String(value);
		input.addEventListener('input', () => onChange(Number(input.value) || 0));
		return input;
	}

	protected selectField<T extends string>(value: T, options: [T, string][], onChange: (value: T) => void): HTMLSelectElement {
		const select = document.createElement('select');
		for (const [optionValue, label] of options) {
			select.appendChild(new Option(label, optionValue, false, optionValue === value));
		}
		select.addEventListener('change', () => onChange(select.value as T));
		return select;
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
