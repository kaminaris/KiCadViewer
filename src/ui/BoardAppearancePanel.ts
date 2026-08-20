import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { colorForLayer }           from '@kicad-render/paint/LayerColors';
import { layerPanelOrder }         from '@kicad-render/paint/LayerOrder';

type AppearanceTab = 'layers' | 'objects' | 'nets';
type DisplayMode = 'normal' | 'dim' | 'hide';

interface BoardScene {
	layersPresent: string[];
	hitTestItems: Array<{ kind: string; element: any }>;
}

export interface BoardAppearancePanelCallbacks {
	getSession(): KicadRenderSession | null;

	setStatus(message: string): void;

	getActiveLayer(): string;

	setActiveLayer(layer: string): void;

	/** Optional: called whenever the user changes per-layer visibility/opacity */
	onLayerStateChange?: (state: Record<string, { visible: boolean; opacity: number }>) => void;
	/** Optional: called when any Objects-tab setting changes. Passes an object with visible_items (string[]), opacity (board opacity object), and displayModes */
	onObjectsStateChange?: (state: {
		visible_items?: string[];
		opacity?: Record<string, number>;
		displayModes?: Record<string, any>
	}) => void;
}

/** KiCad-style PCB Appearance dock. Layer controls are live today; the
 * selected active layer becomes routing state once the interactive router is
 * introduced. */
export class BoardAppearancePanel {
	protected tab: AppearanceTab = 'layers';
	protected displayMode: DisplayMode = 'normal';
	protected activeLayer = '';
	protected readonly baseVisibility = new Map<string, boolean>();
	protected readonly baseOpacity = new Map<string, number>();
	protected layerSignature = '';
	protected scene: BoardScene | null = null;

	constructor(protected readonly element: HTMLElement, protected readonly callbacks: BoardAppearancePanelCallbacks) {}

	get isHighContrast(): boolean {
		return this.displayMode !== 'normal';
	}

	/** Mirrors Pcbnew's high-contrast mode cycling for inactive layers. */
	cycleHighContrastMode(): void {
		const session = this.callbacks.getSession();
		const scene = session?.activeScene as BoardScene | null;
		if (!session || session.documentTypeLoaded !== 'board' || !scene) {
			return;
		}
		this.captureLayerState(session, scene);
		this.displayMode = this.displayMode === 'normal' ? 'dim'
			: this.displayMode === 'dim' ? 'hide' : 'normal';
		this.applyLayerState(session, scene.layersPresent);
		this.render(session, scene);
	}

	refresh(): void {
		const session = this.callbacks.getSession();
		if (!session || session.documentTypeLoaded !== 'board') {
			this.element.replaceChildren();
			return;
		}
		const scene = session.activeScene as BoardScene | null;
		if (!scene) {
			return;
		}
		this.captureLayerState(session, scene);
		this.render(session, scene);
	}

	protected captureLayerState(session: KicadRenderSession, scene: BoardScene): void {
		const layers = scene.layersPresent;
		const signature = layers.join('|');
		const requested = this.callbacks.getActiveLayer();
		if (scene === this.scene && signature === this.layerSignature) {
			if (layers.includes(requested)) {
				this.activeLayer = requested;
				session.setActiveBoardLayer(this.activeLayer);
			}
			return;
		}
		this.scene = scene;
		this.layerSignature = signature;
		this.baseVisibility.clear();
		this.baseOpacity.clear();
		for (const layer of layers) {
			const state = session.activeLayerState.get(layer);
			this.baseVisibility.set(layer, state?.visible ?? true);
			this.baseOpacity.set(layer, state?.opacity ?? 1);
		}
		this.activeLayer = layers.includes(requested)
			? requested
			: (layers.includes('F.Cu') ? 'F.Cu' : layers[0] ?? '');
		this.callbacks.setActiveLayer(this.activeLayer);
		session.setActiveBoardLayer(this.activeLayer);
	}

	protected render(session: KicadRenderSession, scene: BoardScene): void {
		const title = document.createElement('header');
		title.className = 'appearance-title';
		title.textContent = 'Appearance';
		const tabs = document.createElement('nav');
		tabs.className = 'appearance-tabs';
		for (const [id, label] of [['layers', 'Layers'], ['objects', 'Objects'], ['nets', 'Nets']] as const) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `appearance-tab${ this.tab === id ? ' active' : '' }`;
			button.textContent = label;
			button.addEventListener('click', () => {
				this.tab = id;
				this.render(session, scene);
			});
			tabs.appendChild(button);
		}
		const content = document.createElement('div');
		content.className = 'appearance-content';
		content.appendChild(this.tab === 'layers' ? this.layersContent(session, scene)
			: this.tab === 'objects' ? this.objectsContent(session, scene) : this.netsContent(scene));
		this.element.replaceChildren(title, tabs, content);
	}

	protected layersContent(session: KicadRenderSession, scene: BoardScene): HTMLElement {
		const content = document.createElement('div');
		const list = document.createElement('ul');
		list.className = 'appearance-layer-list';
		// PadNumbers is a synthetic overlay bucket, not a real KiCad layer —
		// its own Pad Numbers/Net Names checkboxes (Objects tab) control it;
		// listing it here would let per-layer dim/hide controls fight with
		// BoardPainter.paint()'s deliberate always-on-top exemption for it.
		//
		// Row order is real KiCad's own Layers-panel order (layerPanelOrder —
		// see its own doc comment), NOT scene.layersPresent's array order,
		// which is the bottom-to-top WebGL/Canvas PAINT z-order
		// (layerPaintOrder) — a genuinely different sequence real KiCad
		// never uses for its own panel. Any present layer layerPanelOrder
		// doesn't know about (e.g. a future/synthetic bucket) still falls
		// through via `extra`, appended at the end in its original paint
		// order, so nothing that used to show can silently disappear.
		const present = scene.layersPresent.filter(l => l !== 'PadNumbers');
		const presentSet = new Set(present);
		const known = layerPanelOrder.filter(l => presentSet.has(l));
		const extra = present.filter(l => !layerPanelOrder.includes(l));
		for (const layer of [...known, ...extra]) {
			const row = document.createElement('li');
			row.className = `appearance-layer-row${ layer === this.activeLayer ? ' active' : '' }`;
			row.title = `Set ${ layer } as active layer`;
			row.addEventListener('click', () => {
				this.activeLayer = layer;
				this.callbacks.setActiveLayer(layer);
				session.setActiveBoardLayer(layer);
				this.applyLayerState(session, scene.layersPresent);
				this.render(session, scene);
			});
			const visible = document.createElement('input');
			visible.type = 'checkbox';
			visible.checked = this.baseVisibility.get(layer) ?? true;
			visible.title = `Show ${ layer }`;
			visible.addEventListener('click', event => event.stopPropagation());
			visible.addEventListener('change', () => {
				this.baseVisibility.set(layer, visible.checked);
				this.applyLayerState(session, scene.layersPresent);
			});
			const swatch = document.createElement('span');
			swatch.className = 'appearance-swatch';
			swatch.style.background = colorForLayer(layer);
			const name = document.createElement('span');
			name.className = 'appearance-layer-name';
			name.textContent = layer;
			const opacity = document.createElement('select');
			opacity.title = `${ layer } opacity`;
			for (const value of [100, 75, 50, 25, 10]) {
				opacity.appendChild(new Option(
					`${ value }%`, String(value), false,
					Math.round((this.baseOpacity.get(layer) ?? 1) * 100) === value
				));
			}
			opacity.addEventListener('click', event => event.stopPropagation());
			opacity.addEventListener('change', () => {
				this.baseOpacity.set(layer, Number(opacity.value) / 100);
				this.applyLayerState(session, scene.layersPresent);
			});
			row.append(visible, swatch, name, opacity);
			list.appendChild(row);
		}
		content.append(list, this.displayControls(session, scene.layersPresent));
		return content;
	}

	protected displayControls(session: KicadRenderSession, layers: string[]): HTMLElement {
		const section = document.createElement('section');
		section.className = 'appearance-section';
		const heading = document.createElement('h3');
		heading.textContent = 'Layer Display Options';
		const options = document.createElement('div');
		options.className = 'appearance-display-options';
		for (const [mode, label] of [['normal', 'Normal'], ['dim', 'Dim'], ['hide', 'Hide']] as const) {
			const button = document.createElement('button');
			button.type = 'button';
			button.classList.toggle('active', this.displayMode === mode);
			button.textContent = label;
			button.addEventListener('click', () => {
				this.displayMode = mode;
				this.applyLayerState(session, layers);
				this.refresh();
			});
			options.appendChild(button);
		}
		const flip = document.createElement('button');
		flip.type = 'button';
		flip.className = 'appearance-flip';
		flip.textContent = `${ session.isFlipped ? '✓ ' : '' }Flip board view`;
		flip.addEventListener('click', () => {
			session.setFlipped(!session.isFlipped);
			this.refresh();
		});
		section.append(heading, options, flip);
		return section;
	}

	protected objectsContent(session: KicadRenderSession, scene: BoardScene): HTMLElement {
		const content = document.createElement('div');
		// Controls: Tracks / Vias / Pads / Zones display modes
		const makeModeRow = (
			labelText: string, getMode: () => 'filled' | 'outline', setMode: (m: 'filled' | 'outline') => void) => {
			const row = document.createElement('div');
			row.className = 'appearance-mode-row';
			const label = document.createElement('span');
			label.textContent = labelText;
			const select = document.createElement('select');
			select.dataset.modeKey = labelText.toLowerCase();
			select.appendChild(new Option('Filled', 'filled', false, getMode() === 'filled'));
			select.appendChild(new Option('Outline', 'outline', false, getMode() === 'outline'));
			select.addEventListener('change', () => {
				const val = select.value as 'filled' | 'outline';
				setMode(val);
				this.emitObjectsStateChange();
			});
			row.append(label, select);
			return row;
		};
		content.appendChild(makeModeRow(
			'Tracks', () => session.currentTrackDisplayMode ?? 'filled',
			m => session.setTrackDisplayMode(m)
		));
		content.appendChild(
			makeModeRow('Vias', () => session.currentViaDisplayMode ?? 'filled', m => session.setViaDisplayMode(m)));
		content.appendChild(
			makeModeRow('Pads', () => session.currentPadDisplayMode ?? 'filled', m => session.setPadDisplayMode(m)));
		content.appendChild(
			makeModeRow('Zones', () => session.currentZoneDisplayMode ?? 'filled', m => session.setZoneDisplayMode(m)));

		// Images opacity (mapped to PRL.board.opacity.images)
		const imagesRow = document.createElement('div');
		imagesRow.className = 'appearance-object-row';
		const imagesLabel = document.createElement('span');
		imagesLabel.textContent = 'Images';
		const imagesSlider = document.createElement('input');
		imagesSlider.type = 'range';
		imagesSlider.dataset.opacityKey = 'images';
		imagesSlider.min = '0';
		imagesSlider.max = '100';
		imagesSlider.value = String(Math.round(0.6 * 100));
		imagesSlider.addEventListener('input', () => this.emitObjectsStateChange());
		imagesRow.append(imagesLabel, imagesSlider);
		content.appendChild(imagesRow);

		// Common object toggles (visible_items keys). Default to session-known flags where possible.
		const visibleKeys = [
			['tracks', 'Tracks'], ['vias', 'Vias'], ['pads', 'Pads'], ['zones', 'Zones'], ['bitmaps', 'Images'],
			['footprints_front', 'Footprints Front'], ['footprints_back', 'Footprints Back'],
			['footprint_values', 'Values'],
			['footprint_references', 'References'], ['footprint_text', 'Footprint Text'],
			['drawing_sheet', 'Drawing Sheet'], ['grid', 'Grid'],
			['drc_warnings', 'DRC Warnings'], ['drc_errors', 'DRC Errors'], ['drc_exclusions', 'DRC Exclusions'],
			['locked_item_shadows', 'Locked Item Shadow'], ['conflict_shadows', 'Colliding Courtyards'],
			['board_outline_area', 'Board Area Shadow'],
			['ly_points', 'Points'], ['footprint_anchors', 'Anchors'], ['ratsnest', 'Ratsnest']
		] as const;
		const list = document.createElement('ul');
		list.className = 'appearance-object-toggle-list';
		for (const [key, labelText] of visibleKeys) {
			const li = document.createElement('li');
			li.className = 'appearance-object-toggle';
			li.dataset.key = key;
			const chk = document.createElement('input');
			chk.type = 'checkbox';
			// Heuristic defaults from session where available
			if (key === 'ratsnest') {
				chk.checked = session.isRatsnestVisible;
			}
			else if (key === 'grid') {
				chk.checked = true;
			}
			else {
				chk.checked = true;
			}
			chk.addEventListener('change', () => {
				// apply immediate known effects
				if (key === 'ratsnest') {
					session.setRatsnestVisible(chk.checked);
				}
				if (key === 'grid') {
					session.setGridVisible(chk.checked);
				}
				this.emitObjectsStateChange();
			});
			li.append(chk, ' ', labelText);
			list.appendChild(li);
		}
		content.appendChild(list);

		// Count summary (existing behavior)
		const countByKind = new Map<string, number>();
		for (const item of scene.hitTestItems) {
			countByKind.set(item.kind, (countByKind.get(item.kind) ?? 0) + 1);
		}
		if (countByKind.size) {
			const counts = document.createElement('ul');
			counts.className = 'appearance-list';
			const labels: Record<string, string> = {
				'footprint-ref': 'Footprints',
				pad: 'Pads',
				track: 'Tracks',
				via: 'Vias',
				zone: 'Zones',
				graphic: 'Graphics'
			};
			for (const [kind, count] of countByKind) {
				const row = document.createElement('li');
				row.className = 'appearance-object-row';
				row.append(labels[kind] ?? kind, this.count(count));
				counts.appendChild(row);
			}
			content.appendChild(counts);
		}
		return content;
	}

	protected netsContent(scene: BoardScene): HTMLElement {
		const content = document.createElement('div');
		const nets = new Map<string, number>();
		for (const item of scene.hitTestItems) {
			const net = item.element?.findFirstChildByName?.('net')?.netName;
			if (typeof net === 'string' && net) {
				nets.set(net, (nets.get(net) ?? 0) + 1);
			}
		}
		if (!nets.size) {
			content.className = 'appearance-empty';
			content.textContent = 'This board has no routed net items to list yet.';
			return content;
		}
		const list = document.createElement('ul');
		list.className = 'appearance-list';
		for (const [net, count] of [...nets].sort(([a], [b]) => a.localeCompare(b))) {
			const row = document.createElement('li');
			row.className = 'appearance-net-row';
			row.append(net, this.count(count));
			list.appendChild(row);
		}
		content.appendChild(list);
		return content;
	}

	protected applyLayerState(session: KicadRenderSession, layers: string[]): void {
		const state: Record<string, { visible: boolean; opacity: number }> = {};
		for (const layer of layers) {
			const visible = (this.baseVisibility.get(layer) ?? true) &&
				(this.displayMode !== 'hide' || layer === this.activeLayer);
			const opacity = this.displayMode === 'dim' && layer !== this.activeLayer
				? Math.min(this.baseOpacity.get(layer) ?? 1, 0.18) : (this.baseOpacity.get(layer) ?? 1);
			session.setLayerVisible(layer, visible);
			session.setLayerOpacity(layer, opacity);
			state[layer] = { visible, opacity };
		}
		if (typeof this.callbacks.onLayerStateChange === 'function') {
			this.callbacks.onLayerStateChange(state);
		}
	}

	protected emitObjectsStateChange(): void {
		if (typeof this.callbacks.onObjectsStateChange !== 'function') {
			return;
		}
		const container = this.element;
		const visible_items: string[] = [];
		// gather toggles from list
		for (const li of Array.from(container.querySelectorAll('.appearance-object-toggle-list li'))) {
			const key = (li as HTMLElement).dataset.key;
			const chk = li.querySelector('input[type=checkbox]') as HTMLInputElement | null;
			if (key && chk && chk.checked) {
				visible_items.push(key);
			}
		}
		// gather opacity sliders
		const opacity: Record<string, number> = {};
		for (const input of Array.from(container.querySelectorAll('input[type=range]'))) {
			const k = (input as HTMLElement).dataset.opacityKey;
			if (k) {
				opacity[k] = (Number((input as HTMLInputElement).value) || 0) / 100;
			}
		}
		// display modes
		const displayModes: Record<string, any> = {};
		for (const sel of Array.from(
			container.querySelectorAll('.appearance-mode-row select')) as HTMLSelectElement[]) {
			const key = (sel as HTMLElement).dataset.modeKey ?? (sel.previousSibling
				&& (sel.previousSibling as HTMLElement).textContent?.trim().toLowerCase());
			if (key) {
				displayModes[key as string] = sel.value;
			}
		}
		this.callbacks.onObjectsStateChange({ visible_items, opacity, displayModes });
	}

	protected count(value: number): HTMLElement {
		const count = document.createElement('span');
		count.className = 'appearance-count';
		count.textContent = String(value);
		return count;
	}
}
