import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { colorForLayer } from '@kicad-render/paint/LayerColors';

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
			button.addEventListener('click', () => { this.tab = id; this.render(session, scene); });
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
		for (const layer of scene.layersPresent) {
			const row = document.createElement('li');
			row.className = `appearance-layer-row${ layer === this.activeLayer ? ' active' : '' }`;
			row.title = `Set ${ layer } as active layer`;
			row.addEventListener('click', () => {
				this.activeLayer = layer;
				this.callbacks.setActiveLayer(layer);
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
				opacity.appendChild(new Option(`${ value }%`, String(value), false,
					Math.round((this.baseOpacity.get(layer) ?? 1) * 100) === value));
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
		flip.addEventListener('click', () => { session.setFlipped(!session.isFlipped); this.refresh(); });
		section.append(heading, options, flip);
		return section;
	}

	protected objectsContent(session: KicadRenderSession, scene: BoardScene): HTMLElement {
		const content = document.createElement('div');
		const ratsnest = document.createElement('label');
		ratsnest.className = 'appearance-object-toggle';
		const ratsnestVisible = document.createElement('input');
		ratsnestVisible.type = 'checkbox';
		ratsnestVisible.checked = session.isRatsnestVisible;
		ratsnestVisible.addEventListener('change', () => session.setRatsnestVisible(ratsnestVisible.checked));
		ratsnest.append(ratsnestVisible, ' Ratsnest');
		content.appendChild(ratsnest);
		const countByKind = new Map<string, number>();
		for (const item of scene.hitTestItems) {
			countByKind.set(item.kind, (countByKind.get(item.kind) ?? 0) + 1);
		}
		if (!countByKind.size) {
			content.className = 'appearance-empty';
			content.textContent = 'No board objects are visible.';
			return content;
		}
		const labels: Record<string, string> = {
			'footprint-ref': 'Footprints', pad: 'Pads', track: 'Tracks', via: 'Vias', zone: 'Zones', graphic: 'Graphics'
		};
		const list = document.createElement('ul');
		list.className = 'appearance-list';
		for (const [kind, count] of countByKind) {
			const row = document.createElement('li');
			row.className = 'appearance-object-row';
			row.append(labels[kind] ?? kind, this.count(count));
			list.appendChild(row);
		}
		content.appendChild(list);
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
		for (const layer of layers) {
			const visible = (this.baseVisibility.get(layer) ?? true) &&
				(this.displayMode !== 'hide' || layer === this.activeLayer);
			const opacity = this.displayMode === 'dim' && layer !== this.activeLayer
				? Math.min(this.baseOpacity.get(layer) ?? 1, 0.18) : (this.baseOpacity.get(layer) ?? 1);
			session.setLayerVisible(layer, visible);
			session.setLayerOpacity(layer, opacity);
		}
	}

	protected count(value: number): HTMLElement {
		const count = document.createElement('span');
		count.className = 'appearance-count';
		count.textContent = String(value);
		return count;
	}
}
