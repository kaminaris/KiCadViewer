import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { PropertyPanel } from '../ui/PropertyPanel';
import type { PropertiesDialog } from '../ui/PropertiesDialog';

interface BoardHit {
	id: string;
	kind: string;
	layer: string;
	element: any;
}

export interface BoardPropertiesControllerDeps {
	getSession(): KicadRenderSession | null;
	panel: PropertyPanel;
	dialog: PropertiesDialog;
	refreshBoardText(session: KicadRenderSession): void;
	refreshUndo(): void;
}

/** Board-specific property fields over the existing generic sidebar/modal
 * primitives. Pad data is intentionally read-only: repositioning individual
 * pads belongs in a footprint editor, not the PCB placement/routing surface. */
export class BoardPropertiesController {
	constructor(protected readonly deps: BoardPropertiesControllerDeps) {}

	renderSidebar(hit: BoardHit): boolean {
		if (!this.supports(hit.kind)) return false;
		this.deps.panel.clear();
		const section = this.deps.panel.section(this.title(hit));
		this.renderPanelRows(section, hit);
		return true;
	}

	showModal(hit: BoardHit): boolean {
		if (!this.supports(hit.kind)) return false;
		this.deps.dialog.clear();
		this.deps.dialog.setTitle(`${ this.title(hit) } Properties`);
		const section = this.deps.dialog.section(this.deps.dialog.body, 'General');
		this.renderDialogRows(section, hit);
		this.deps.dialog.show();
		this.deps.refreshUndo();
		return true;
	}

	protected supports(kind: string): boolean {
		return kind === 'footprint' || kind === 'track' || kind === 'via' || kind === 'pad';
	}

	protected title(hit: BoardHit): string {
		return hit.kind === 'footprint' ? 'Footprint' : hit.kind === 'track' ? 'Track'
			: hit.kind === 'via' ? 'Via' : 'Pad';
	}

	protected mutate(hit: BoardHit, fn: (element: any) => void): void {
		const session = this.deps.getSession();
		if (!session?.mutateElementByPaintId(hit.id, fn)) return;
		this.deps.refreshBoardText(session);
		this.deps.refreshUndo();
	}

	protected netLabel(element: any): string {
		const id = typeof element.getNetId === 'function' ? element.getNetId() : null;
		const name = typeof element.getNetName === 'function' ? element.getNetName() : null;
		return id === null ? (name || 'Unconnected') : `${ id }${ name ? ` · ${ name }` : '' }`;
	}

	protected copperOptions(): { value: string; label: string }[] {
		return (this.deps.getSession()?.activeScene?.layersPresent ?? [])
			.filter(layer => layer.endsWith('.Cu')).map(layer => ({ value: layer, label: layer }));
	}

	protected renderPanelRows(section: HTMLElement, hit: BoardHit): void {
		const el = hit.element;
		if (hit.kind === 'footprint') {
			const props = el.getAllProperties?.() ?? {};
			const origin = el.getOrigin();
			this.deps.panel.row(section, 'Reference', props.Reference ?? '', true,
				value => this.mutate(hit, current => current.setProperty('Reference', value)));
			this.deps.panel.row(section, 'Value', props.Value ?? '', true,
				value => this.mutate(hit, current => current.setProperty('Value', value)));
			this.deps.panel.row(section, 'Rotation', String(origin.rotation ?? 0), true,
				value => this.mutate(hit, current => { const at = current.getOrigin(); current.setOrigin(at.x, at.y, Number(value) || 0); }));
			this.deps.panel.row(section, 'Layer', el.getLayer?.() || hit.layer);
		}
		else if (hit.kind === 'track') {
			this.deps.panel.row(section, 'Width (mm)', String(el.getWidth()), true,
				value => this.mutate(hit, current => current.setWidth(Math.max(0.01, Number(value) || 0.25))));
			this.deps.panel.select(section, 'Layer', el.getLayer(), this.copperOptions(),
				value => this.mutate(hit, current => current.setLayer(value)));
			this.deps.panel.row(section, 'Net', this.netLabel(el));
		}
		else if (hit.kind === 'via') {
			this.deps.panel.row(section, 'Size (mm)', String(el.getSize().width), true,
				value => this.mutate(hit, current => current.setSize(Math.max(0.1, Number(value) || 0.6))));
			this.deps.panel.row(section, 'Drill (mm)', String(el.getDrill().width), true,
				value => this.mutate(hit, current => current.setDrill(Math.max(0.05, Number(value) || 0.3))));
			this.deps.panel.row(section, 'Layers', el.getLayers().join(', '), true,
				value => this.mutate(hit, current => current.setLayers(this.parseLayers(value))));
			this.deps.panel.row(section, 'Net', this.netLabel(el));
		}
		else {
			const size = el.getSize?.() ?? { width: 0, height: 0 };
			this.deps.panel.row(section, 'Number', String(el.padNumber ?? ''));
			this.deps.panel.row(section, 'Type', String(el.padType ?? ''));
			this.deps.panel.row(section, 'Shape', String(el.shape ?? ''));
			this.deps.panel.row(section, 'Size', `${ size.width } × ${ size.height } mm`);
			this.deps.panel.row(section, 'Net', this.netLabel(el));
		}
	}

	protected renderDialogRows(section: HTMLElement, hit: BoardHit): void {
		const el = hit.element;
		const row = (label: string, value: string, save?: (value: string) => void, numeric = false) => {
			const line = this.deps.dialog.row(section);
			this.deps.dialog.label(line, label);
			const input = this.deps.dialog.textInput(line, value, save ?? (() => {}), numeric);
			if (!save) input.disabled = true;
		};
		if (hit.kind === 'footprint') {
			const props = el.getAllProperties?.() ?? {};
			const origin = el.getOrigin();
			row('Reference', props.Reference ?? '', value => this.mutate(hit, current => current.setProperty('Reference', value)));
			row('Value', props.Value ?? '', value => this.mutate(hit, current => current.setProperty('Value', value)));
			row('Rotation', String(origin.rotation ?? 0), value => this.mutate(hit, current => { const at = current.getOrigin(); current.setOrigin(at.x, at.y, Number(value) || 0); }), true);
			row('Layer', el.getLayer?.() || hit.layer);
		}
		else if (hit.kind === 'track') {
			row('Width (mm)', String(el.getWidth()), value => this.mutate(hit, current => current.setWidth(Math.max(0.01, Number(value) || 0.25))), true);
			const layerRow = this.deps.dialog.row(section); this.deps.dialog.label(layerRow, 'Layer');
			this.deps.dialog.select(layerRow, el.getLayer(), this.copperOptions(), value => this.mutate(hit, current => current.setLayer(value)));
			row('Net', this.netLabel(el));
		}
		else if (hit.kind === 'via') {
			row('Size (mm)', String(el.getSize().width), value => this.mutate(hit, current => current.setSize(Math.max(0.1, Number(value) || 0.6))), true);
			row('Drill (mm)', String(el.getDrill().width), value => this.mutate(hit, current => current.setDrill(Math.max(0.05, Number(value) || 0.3))), true);
			row('Layers', el.getLayers().join(', '), value => this.mutate(hit, current => current.setLayers(this.parseLayers(value))));
			row('Net', this.netLabel(el));
		}
		else {
			const size = el.getSize?.() ?? { width: 0, height: 0 };
			row('Number', String(el.padNumber ?? ''));
			row('Type', String(el.padType ?? ''));
			row('Shape', String(el.shape ?? ''));
			row('Size', `${ size.width } × ${ size.height } mm`);
			row('Net', this.netLabel(el));
		}
	}

	protected parseLayers(value: string): string[] {
		const valid = new Set(this.copperOptions().map(option => option.value));
		const layers = value.split(',').map(layer => layer.trim()).filter(layer => valid.has(layer));
		return layers.length >= 2 ? layers : ['F.Cu', 'B.Cu'];
	}
}
