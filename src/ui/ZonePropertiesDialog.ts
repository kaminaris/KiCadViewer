import type { ZoneDraft } from '@kicad-render/KicadRenderSession';
import {
	colorForLayer
}                         from '@kicad-render/paint/LayerColors';
import type {
	ZonePadConnectionType, ZoneSmoothingType, ZoneIslandRemovalMode, ZoneHatchStyle
}                         from '@kicad-io/KicadElementZone';

export interface ZonePropertiesDialogCallbacks {
	getCopperLayers(): string[];

	getNets(): { id: number; name: string }[];
}

type Tab = 'clearances' | 'display';

/** Real KiCad's Copper Zone Properties dialog (DIALOG_COPPER_ZONE) — reached
 *  both by finishing a zone-outline draw gesture (BoardPointerController's
 *  'zone' tool) and by double-clicking an existing zone. Reuses the
 *  Preferences modal's `.preferences-*` shell, the same precedent
 *  RouterSettingsDialog/LayerPairDialog already follow, plus a small new
 *  `.zone-props-*` set for the two-column Layers-list/fields body and the
 *  tab strip neither of those needed. Only "solid fill" zones are modeled —
 *  real KiCad's own "Hatched Fill" tab only ever appears once a zone's fill
 *  type is switched to hatch pattern, which this app's zone-fill pipeline
 *  (BoardZoneFill.ts) doesn't compute yet, so omitting that tab here matches
 *  real KiCad's own conditional visibility rather than being a shortcut. */
export class ZonePropertiesDialog {
	protected readonly element = document.createElement('div');
	protected draft: ZoneDraft = ZonePropertiesDialog.blankDraft();
	protected activeTab: Tab = 'clearances';
	protected onCommit: ((draft: ZoneDraft) => void) | null = null;

	constructor(protected readonly callbacks: ZonePropertiesDialogCallbacks) {
		this.element.className = 'preferences-modal zone-props-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-labelledby', 'zone-props-title');
		document.body.appendChild(this.element);
	}

	static blankDraft(): ZoneDraft {
		return {
			layers: [], netId: 0, netName: '', name: '', locked: false,
			clearanceMm: 0.5, minThicknessMm: 0.25, padConnection: 'thermal',
			thermalGapMm: 0.5, thermalSpokeWidthMm: 0.5,
			cornerSmoothing: 'none', cornerRadiusMm: 0,
			islandRemoval: 'always', islandAreaMinMm: 10,
			priority: 0, hatchStyle: 'edge', hatchPitchMm: 0.5
		};
	}

	open(initial: ZoneDraft, onCommit: (draft: ZoneDraft) => void): void {
		this.draft = { ...initial, layers: [...initial.layers] };
		this.onCommit = onCommit;
		this.activeTab = 'clearances';
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
		heading.id = 'zone-props-title';
		heading.textContent = 'Copper Zone Properties';
		const closeBtn = this.button('×', () => this.close());
		closeBtn.className = 'preferences-close';
		closeBtn.setAttribute('aria-label', 'Close zone properties');
		title.append(heading, closeBtn);

		const body = document.createElement('div');
		body.className = 'zone-props-body';
		body.append(this.layersColumn(), this.mainColumn());

		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		const okBtn = this.button('OK', () => {
			if (this.draft.layers.length === 0 || !this.onCommit) {
				return;
			}
			this.onCommit(this.draft);
			this.close();
		});
		okBtn.disabled = this.draft.layers.length === 0;
		footer.append(spacer, this.button('Cancel', () => this.close()), okBtn);

		this.element.replaceChildren(title, body, footer);
	}

	protected layersColumn(): HTMLElement {
		const column = document.createElement('div');
		column.className = 'zone-props-layers';
		const heading = document.createElement('h3');
		heading.textContent = 'Layers:';
		column.appendChild(heading);
		for (const layer of this.callbacks.getCopperLayers()) {
			const row = document.createElement('label');
			row.className = 'zone-props-layer-row';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = this.draft.layers.includes(layer);
			checkbox.addEventListener('change', () => {
				this.draft.layers = checkbox.checked
					? [...this.draft.layers, layer]
					: this.draft.layers.filter(l => l !== layer);
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

		if (this.draft.netId === 0) {
			const warning = document.createElement('div');
			warning.className = 'zone-props-warning';
			warning.textContent = '⚠ <no net> will result in an isolated copper island.';
			column.appendChild(warning);
		}

		column.append(
			this.field('Zone name:', this.textInput(this.draft.name, value => { this.draft.name = value; })),
			this.field('Net name:', this.netSelect()),
			this.checkbox('Locked', this.draft.locked, checked => { this.draft.locked = checked; })
		);

		const tabs = document.createElement('div');
		tabs.className = 'zone-props-tabs';
		tabs.append(
			this.tabButton('Clearances & Pad Connections', 'clearances'),
			this.tabButton('Display Overrides', 'display')
		);
		column.appendChild(tabs);

		const pane = document.createElement('div');
		pane.className = 'zone-props-pane';
		pane.append(this.activeTab === 'clearances' ? this.clearancesTab() : this.displayTab());
		column.appendChild(pane);

		return column;
	}

	protected tabButton(label: string, tab: Tab): HTMLButtonElement {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = `zone-props-tab${ this.activeTab === tab ? ' active' : '' }`;
		btn.textContent = label;
		btn.addEventListener('click', () => {
			this.activeTab = tab;
			this.render();
		});
		return btn;
	}

	protected clearancesTab(): HTMLElement {
		const wrap = document.createElement('div');
		wrap.append(
			this.field(
				'Clearance:', this.numberField(this.draft.clearanceMm, value => { this.draft.clearanceMm = value; }),
				'mm'
			),
			this.field(
				'Minimum width:',
				this.numberField(this.draft.minThicknessMm, value => { this.draft.minThicknessMm = value; }), 'mm'
			),
			this.field('Pad connections:', this.selectField<ZonePadConnectionType>(this.draft.padConnection, [
				['thermal', 'Thermal reliefs'], ['full', 'Solid'], ['thru_hole_only', 'Thru-hole only'],
				['none', 'None']
			], value => {
				this.draft.padConnection = value;
				this.render();
			})),
			this.field(
				'Thermal relief gap:',
				this.numberField(this.draft.thermalGapMm, value => { this.draft.thermalGapMm = value; }), 'mm'
			)
		);
		if (this.draft.padConnection === 'thermal') {
			wrap.append(this.field(
				'Thermal spoke width:',
				this.numberField(this.draft.thermalSpokeWidthMm, value => { this.draft.thermalSpokeWidthMm = value; }),
				'mm'
			));
		}
		wrap.append(this.field('Corner smoothing:', this.selectField<ZoneSmoothingType>(this.draft.cornerSmoothing, [
			['none', 'None'], ['chamfer', 'Chamfer'], ['fillet', 'Fillet']
		], value => {
			this.draft.cornerSmoothing = value;
			this.render();
		})));
		if (this.draft.cornerSmoothing !== 'none') {
			wrap.append(this.field(
				'Smoothing amount:',
				this.numberField(this.draft.cornerRadiusMm, value => { this.draft.cornerRadiusMm = value; }), 'mm'
			));
		}
		wrap.append(this.field('Remove islands:', this.selectField<ZoneIslandRemovalMode>(this.draft.islandRemoval, [
			['always', 'Always'], ['never', 'Never'], ['area', 'Below area limit']
		], value => {
			this.draft.islandRemoval = value;
			this.render();
		})));
		if (this.draft.islandRemoval === 'area') {
			wrap.append(this.field(
				'Minimum island area:',
				this.numberField(this.draft.islandAreaMinMm, value => { this.draft.islandAreaMinMm = value; }), 'mm²'
			));
		}
		return wrap;
	}

	protected displayTab(): HTMLElement {
		const wrap = document.createElement('div');
		wrap.append(
			this.field(
				'Zone priority level:',
				this.numberField(this.draft.priority, value => { this.draft.priority = value; }, '1')
			),
			this.field('Outline display:', this.selectField<ZoneHatchStyle>(this.draft.hatchStyle, [
				['none', 'No hatch'], ['edge', 'Edge hatch'], ['full', 'Full hatch']
			], value => {
				this.draft.hatchStyle = value;
				this.render();
			}))
		);
		if (this.draft.hatchStyle !== 'none') {
			wrap.append(this.field(
				'Hatch pitch:',
				this.numberField(this.draft.hatchPitchMm, value => { this.draft.hatchPitchMm = value; }), 'mm'
			));
		}
		return wrap;
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

	protected numberField(value: number, onChange: (value: number) => void, step = '0.01'): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'number';
		input.step = step;
		input.min = '0';
		input.value = String(value);
		input.addEventListener('input', () => onChange(Number(input.value) || 0));
		return input;
	}

	protected selectField<T extends string>(
		value: T, options: [T, string][], onChange: (value: T) => void): HTMLSelectElement {
		const select = document.createElement('select');
		for (const [optionValue, label] of options) {
			select.appendChild(new Option(label, optionValue, false, optionValue === value));
		}
		select.addEventListener('change', () => onChange(select.value as T));
		return select;
	}

	protected netSelect(): HTMLSelectElement {
		const select = document.createElement('select');
		select.appendChild(new Option('<no net>', '0', false, this.draft.netId === 0));
		for (const net of this.callbacks.getNets()) {
			if (net.id === 0 || !net.name) {
				continue;
			}
			select.appendChild(
				new Option(`${ net.id } · ${ net.name }`, String(net.id), false, this.draft.netId === net.id));
		}
		select.addEventListener('change', () => {
			this.draft.netId = Number(select.value);
			const net = this.callbacks.getNets().find(n => n.id === this.draft.netId);
			this.draft.netName = net?.name ?? '';
			this.render();
		});
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
