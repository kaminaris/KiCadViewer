import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { PropertyPanel } from '../ui/PropertyPanel';
import type { PropertiesDialog } from '../ui/PropertiesDialog';
import { KicadElementDimension } from '@kicad-io/KicadElementDimension';

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
	/** Zones get their own tabbed Copper Zone Properties dialog rather than
	 *  the generic row-based modal every other board kind here uses — see
	 *  ZonePropertiesDialog's doc comment. */
	openZoneEditDialog(paintId: string): void;
	/** Text uses KiCad's purpose-built dialog because its controls are a
	 * cohesive edit that must be cancellable, unlike the generic live rows. */
	openTextEditDialog(paintId: string): void;
	openBarcodeEditDialog(paintId: string): void;
	/** Plain graphic polygons get their own Polygon Properties dialog too —
	 *  see PolygonPropertiesDialog's doc comment for why it's not just the
	 *  generic row-based modal (real KiCad has a purpose-built dialog even
	 *  though a polygon's geometry itself stays point-editor-only). */
	openPolygonEditDialog(paintId: string): void;
	/** Re-runs the zone-fill pipeline after a sidebar edit that could affect
	 *  fill geometry (clearance, pad connections, priority, net, layers…) —
	 *  mirrors MainApp's commitZoneDraftAndRefill, which the Copper Zone/Rule
	 *  Area dialogs already call on every OK. Dispatched unconditionally for
	 *  simplicity (matches the dialog's own all-fields-always-refill
	 *  behavior) rather than tracking which specific field changed. */
	refreshZoneFills(): void;
}

/** Board-specific property fields over the existing generic sidebar/modal
 * primitives. Pad data is intentionally read-only: repositioning individual
 * pads belongs in a footprint editor, not the PCB placement/routing surface. */
export class BoardPropertiesController {
	constructor(protected readonly deps: BoardPropertiesControllerDeps) {}

	renderSidebar(hit: BoardHit): boolean {
		if (hit.kind === 'zone') {
			this.deps.panel.clear();
			this.renderZoneSidebar(hit);
			return true;
		}
		if (this.isPolygon(hit.element)) {
			this.deps.panel.clear();
			this.renderPolygonSidebar(hit);
			return true;
		}
		if (this.isDimension(hit.element)) {
			this.deps.panel.clear();
			this.renderDimensionSidebar(hit);
			return true;
		}
		if (this.isText(hit.element)) {
			this.deps.panel.clear();
			this.renderTextSidebar(hit);
			return true;
		}
		if (this.isBarcode(hit.element)) {
			this.deps.panel.clear();
			this.renderBarcodeSidebar(hit);
			return true;
		}
		if (this.isGraphicShape(hit.element)) {
			this.deps.panel.clear();
			this.renderGraphicShapeSidebar(hit);
			return true;
		}
		if (this.isTable(hit.element)) {
			this.deps.panel.clear();
			this.renderTableSidebar(hit);
			return true;
		}
		if (this.isBoardImage(hit.element)) {
			this.deps.panel.clear();
			this.renderImageSidebar(hit);
			return true;
		}
		if (this.isTarget(hit.element)) {
			this.deps.panel.clear();
			this.renderTargetSidebar(hit);
			return true;
		}
		if (this.isCurve(hit.element)) {
			this.deps.panel.clear();
			this.renderCurveSidebar(hit);
			return true;
		}
		if (this.isEllipse(hit.element)) {
			this.deps.panel.clear();
			this.renderEllipseSidebar(hit);
			return true;
		}
		if (!this.supports(hit.kind)) return false;
		this.deps.panel.clear();
		const section = this.deps.panel.section(this.title(hit));
		this.renderPanelRows(section, hit);
		return true;
	}

	showModal(hit: BoardHit): boolean {
		if (hit.kind === 'zone') {
			this.deps.openZoneEditDialog(hit.id);
			return true;
		}
		if (this.isText(hit.element)) {
			this.deps.openTextEditDialog(hit.id);
			return true;
		}
		if (hit.element?.name === 'barcode') {
			this.deps.openBarcodeEditDialog(hit.id);
			return true;
		}
		if (hit.element?.name === 'gr_poly') {
			this.deps.openPolygonEditDialog(hit.id);
			return true;
		}
		if (this.isDimension(hit.element)) {
			this.deps.dialog.clear();
			this.deps.dialog.setTitle('Dimension Properties');
			this.renderDimensionDialog(hit);
			this.deps.dialog.show();
			this.deps.refreshUndo();
			return true;
		}
		if (this.isGraphicShape(hit.element) || this.isCurve(hit.element) || this.isEllipse(hit.element)) {
			this.deps.dialog.clear();
			this.deps.dialog.setTitle(`${ this.SHAPE_FRIENDLY_NAMES[hit.element.name] ?? 'Shape' } Properties`);
			this.renderGraphicShapeDialog(hit);
			this.deps.dialog.show();
			this.deps.refreshUndo();
			return true;
		}
		if (this.isTarget(hit.element)) {
			this.deps.dialog.clear();
			this.deps.dialog.setTitle('Target Properties');
			this.renderTargetDialog(hit);
			this.deps.dialog.show();
			this.deps.refreshUndo();
			return true;
		}
		if (this.isBoardImage(hit.element)) {
			this.deps.dialog.clear();
			this.deps.dialog.setTitle('Reference Image Properties');
			this.renderImageDialog(hit);
			this.deps.dialog.show();
			this.deps.refreshUndo();
			return true;
		}
		if (this.isTable(hit.element)) {
			this.deps.dialog.clear();
			this.deps.dialog.setTitle('Table Properties');
			this.renderTableDialog(hit);
			this.deps.dialog.show();
			this.deps.refreshUndo();
			return true;
		}
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

	protected isText(element: any): boolean {
		return element?.name === 'gr_text' || element?.name === 'fp_text' || element?.name === 'gr_text_box';
	}

	protected isPolygon(element: any): boolean {
		return element?.name === 'gr_poly';
	}

	protected isDimension(element: any): boolean {
		return element instanceof KicadElementDimension;
	}

	protected isBarcode(element: any): boolean {
		return element?.name === 'barcode';
	}

	/** Plain board-level graphic line/arc/rectangle/circle — gr_poly's
	 *  siblings in real KiCad's own graphic-shape family. fp_line/fp_rect/
	 *  fp_circle/fp_arc are deliberately excluded — those stay
	 *  `hitTestable: false` (see buildFpLine's doc comment: footprint-owned
	 *  graphics resolve a click to the whole footprint, not the sub-item). */
	protected isGraphicShape(element: any): boolean {
		return element?.name === 'gr_line' || element?.name === 'gr_arc'
			|| element?.name === 'gr_rect' || element?.name === 'gr_circle';
	}

	protected isTable(element: any): boolean {
		return element?.name === 'table';
	}

	protected isBoardImage(element: any): boolean {
		return element?.name === 'image';
	}

	protected isTarget(element: any): boolean {
		return element?.name === 'target';
	}

	protected isCurve(element: any): boolean {
		return element?.name === 'gr_curve';
	}

	protected isEllipse(element: any): boolean {
		return element?.name === 'gr_ellipse' || element?.name === 'gr_ellipse_arc';
	}

	protected title(hit: BoardHit): string {
		return this.isDimension(hit.element) ? 'Dimension'
			: hit.kind === 'footprint' ? 'Footprint' : hit.kind === 'track' ? 'Track'
			: hit.kind === 'via' ? 'Via' : 'Pad';
	}

	protected mutate(hit: BoardHit, fn: (element: any) => void): void {
		const session = this.deps.getSession();
		if (!session?.mutateElementByPaintId(hit.id, fn)) return;
		this.deps.refreshBoardText(session);
		this.deps.refreshUndo();
	}

	/** Same as mutate(), plus a re-fill and a full sidebar re-render — see
	 *  refreshZoneFills' doc comment on why every zone/rule-area edit
	 *  triggers a re-fill unconditionally. The re-render (rebuilding straight
	 *  from the same still-live `hit.element`, which mutateElementByPaintId
	 *  mutates in place rather than replacing) is needed here specifically
	 *  because several zone rows are conditionally shown (e.g. thermal spoke
	 *  width only for thermal-relief pad connections) — unlike every other
	 *  board kind's sidebar rows, which are always visible and so never
	 *  needed this after mutate(). */
	protected mutateZone(hit: BoardHit, fn: (element: any) => void): void {
		this.mutate(hit, fn);
		this.deps.refreshZoneFills();
		this.renderSidebar(hit);
	}

	/** Same reasoning as mutateZone, minus the re-fill — a graphic polygon's
	 *  Net row toggles enabled/disabled based on the Layer row's value. */
	protected mutatePolygon(hit: BoardHit, fn: (element: any) => void): void {
		this.mutate(hit, fn);
		this.renderSidebar(hit);
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

	protected boardLayerOptions(): { value: string; label: string }[] {
		const scene = this.deps.getSession()?.activeScene as { declaredLayers?: string[]; layersPresent?: string[] } | null | undefined;
		const layers = scene?.declaredLayers?.length ? scene.declaredLayers : scene?.layersPresent ?? [];
		return layers.map(layer => ({ value: layer, label: layer }));
	}

	/** Copper zones and rule areas are both KicadElementZone (see
	 *  isPolygon's sibling isRuleArea check on the element itself) — same
	 *  field groupings as ZonePropertiesDialog/RuleAreaPropertiesDialog,
	 *  just as live sidebar rows instead of an OK/Cancel dialog. */
	protected renderZoneSidebar(hit: BoardHit): void {
		const el = hit.element;
		const isRuleArea = typeof el.isRuleArea === 'function' && el.isRuleArea();

		const basic = this.deps.panel.section(isRuleArea ? 'Rule Area' : 'Copper Zone');
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutateZone(hit, current => current.setLocked(value)));
		if (!isRuleArea) {
			const nets = this.deps.getSession()?.getBoardNets() ?? [];
			const options = [{ value: '0', label: '<no net>' },
				...nets.filter((net: { id: number; name: string }) => net.id !== 0 && net.name)
					.map((net: { id: number; name: string }) => ({ value: String(net.id), label: `${ net.id } · ${ net.name }` }))];
			this.deps.panel.select(basic, 'Net', String(el.getNetId() ?? 0), options, value => this.mutateZone(hit, current => {
				const id = Number(value);
				const net = nets.find((candidate: { id: number; name: string }) => candidate.id === id);
				current.setNet(id, net?.name ?? '');
			}));
			this.deps.panel.row(basic, 'Priority', String(el.getPriority()), true,
				value => this.mutateZone(hit, current => current.setPriority(Math.max(0, Math.trunc(Number(value)) || 0))));
		}
		this.deps.panel.row(basic, 'Name', el.getZoneName(), true,
			value => this.mutateZone(hit, current => current.setZoneName(value)));

		if (isRuleArea) {
			const keepout = el.getKeepoutSettings();
			const section = this.deps.panel.section('Keepouts');
			const keepoutRow = (label: string, key: keyof typeof keepout) => {
				this.deps.panel.checkbox(section, label, keepout[key], value => this.mutateZone(hit, current =>
					current.setKeepoutSettings({ ...current.getKeepoutSettings(), [key]: value })));
			};
			keepoutRow('Keep out tracks', 'tracks');
			keepoutRow('Keep out vias', 'vias');
			keepoutRow('Keep out pads', 'pads');
			keepoutRow('Keep out zone fills', 'zoneFills');
			keepoutRow('Keep out footprints', 'footprints');
		}
		else {
			const section = this.deps.panel.section('Clearances & Connections');
			this.deps.panel.row(section, 'Clearance (mm)', String(el.getClearance()), true,
				value => this.mutateZone(hit, current => current.setClearance(Math.max(0, Number(value) || 0))));
			this.deps.panel.row(section, 'Minimum width (mm)', String(el.getMinThickness()), true,
				value => this.mutateZone(hit, current => current.setMinThickness(Math.max(0, Number(value) || 0))));
			const padConnection = el.getPadConnectionType();
			this.deps.panel.select(section, 'Pad connections', padConnection, [
				{ value: 'thermal', label: 'Thermal reliefs' }, { value: 'full', label: 'Solid' },
				{ value: 'thru_hole_only', label: 'Thru-hole only' }, { value: 'none', label: 'None' }
			], value => this.mutateZone(hit, current => current.setPadConnectionType(value)));
			const thermal = el.getThermalRelief();
			this.deps.panel.row(section, 'Thermal relief gap (mm)', String(thermal.gapMm), true, value => this.mutateZone(hit, current => {
				const t = current.getThermalRelief();
				current.setThermalRelief(Math.max(0, Number(value) || 0), t.spokeWidthMm);
			}));
			if (padConnection === 'thermal') {
				this.deps.panel.row(section, 'Thermal relief spoke (mm)', String(thermal.spokeWidthMm), true, value => this.mutateZone(hit, current => {
					const t = current.getThermalRelief();
					current.setThermalRelief(t.gapMm, Math.max(0, Number(value) || 0));
				}));
			}
			const smoothing = el.getCornerSmoothing();
			this.deps.panel.select(section, 'Corner smoothing', smoothing.type, [
				{ value: 'none', label: 'None' }, { value: 'chamfer', label: 'Chamfer' }, { value: 'fillet', label: 'Fillet' }
			], value => this.mutateZone(hit, current => {
				const s = current.getCornerSmoothing();
				current.setCornerSmoothing(value, s.radiusMm);
			}));
			if (smoothing.type !== 'none') {
				this.deps.panel.row(section, 'Smoothing amount (mm)', String(smoothing.radiusMm), true, value => this.mutateZone(hit, current => {
					const s = current.getCornerSmoothing();
					current.setCornerSmoothing(s.type, Math.max(0, Number(value) || 0));
				}));
			}
			const island = el.getIslandRemovalMode();
			this.deps.panel.select(section, 'Remove islands', island.mode, [
				{ value: 'always', label: 'Always' }, { value: 'never', label: 'Never' }, { value: 'area', label: 'Below area limit' }
			], value => this.mutateZone(hit, current => {
				const i = current.getIslandRemovalMode();
				current.setIslandRemovalMode(value, i.areaMinMm);
			}));
			if (island.mode === 'area') {
				this.deps.panel.row(section, 'Minimum island area (mm²)', String(island.areaMinMm), true, value => this.mutateZone(hit, current => {
					const i = current.getIslandRemovalMode();
					current.setIslandRemovalMode(i.mode, Math.max(0, Number(value) || 0));
				}));
			}
		}

		const hatch = el.getHatch();
		const display = this.deps.panel.section('Display');
		this.deps.panel.select(display, 'Outline display', hatch.style, [
			{ value: 'none', label: 'Line' }, { value: 'edge', label: 'Hatched' }, { value: 'full', label: 'Fully hatched' }
		], value => this.mutateZone(hit, current => current.setHatch(value, current.getHatch().pitchMm)));
		if (hatch.style !== 'none') {
			this.deps.panel.row(display, 'Hatch pitch (mm)', String(hatch.pitchMm), true,
				value => this.mutateZone(hit, current => current.setHatch(current.getHatch().style, Math.max(0.01, Number(value) || 0.5))));
		}
	}

	/** Same field set as PolygonPropertiesDialog — see its own doc comment
	 *  for why there's no geometry here (point-editor-only, real KiCad
	 *  parity). Net is shown as read-only text when off a copper layer,
	 *  mirroring the dialog's disabled-input treatment. */
	protected renderPolygonSidebar(hit: BoardHit): void {
		const el = hit.element;
		const section = this.deps.panel.section('Polygon');
		const stroke = el.getStroke();
		this.deps.panel.row(section, 'Line width (mm)', String(stroke.width), true,
			value => this.mutatePolygon(hit, current => current.setStroke(Math.max(0, Number(value) || 0), current.getStroke().type)));
		this.deps.panel.select(section, 'Line style', stroke.type, [
			{ value: 'default', label: 'Default' }, { value: 'solid', label: 'Solid' }, { value: 'dash', label: 'Dashed' },
			{ value: 'dot', label: 'Dotted' }, { value: 'dash_dot', label: 'Dash-Dot' }, { value: 'dash_dot_dot', label: 'Dash-Dot-Dot' }
		], value => this.mutatePolygon(hit, current => current.setStroke(current.getStroke().width, value)));
		this.deps.panel.select(section, 'Fill', el.getFillMode(), [
			{ value: 'no', label: 'None' }, { value: 'yes', label: 'Solid' }, { value: 'hatch', label: 'Hatch' },
			{ value: 'reverse_hatch', label: 'Reverse Hatch' }, { value: 'cross_hatch', label: 'Cross-hatch' }
		], value => this.mutatePolygon(hit, current => current.setFillMode(value)));
		this.deps.panel.select(section, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutatePolygon(hit, current => current.setLayer(value)));
		this.deps.panel.row(section, 'Net', el.getNetName() ?? '', el.getLayer().endsWith('.Cu'),
			value => this.mutatePolygon(hit, current => current.setNetName(value || null)));
		this.deps.panel.checkbox(section, 'Locked', el.isLocked(),
			value => this.mutatePolygon(hit, current => current.setLocked(value)));
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

	protected readonly PRECISION_OPTIONS = [0, 1, 2, 3, 4, 5, 6].map(n => ({ value: String(n), label: n.toFixed(n) }));

	protected readonly UNITS_MODE_OPTIONS = [
		{ value: 'automatic', label: 'Automatic' }, { value: 'mm', label: 'Millimeters' },
		{ value: 'mils', label: 'Mils' }, { value: 'inch', label: 'Inches' },
	];

	protected readonly UNITS_FORMAT_OPTIONS = [
		{ value: 'no_suffix', label: 'No suffix' }, { value: 'bare_suffix', label: '1234' },
		{ value: 'paren_suffix', label: '1234 (mm)' },
	];

	protected readonly ARROW_DIRECTION_OPTIONS = [
		{ value: 'outward', label: 'Outward' }, { value: 'inward', label: 'Inward' },
	];

	/** mutate() plus a full sidebar re-render (needed since the Override
	 *  Text row's editability and the Precision-dependent spoke/thermal-style
	 *  conditional rows elsewhere in this class all depend on re-reading the
	 *  just-mutated element) and, for fields that affect the DISPLAYED
	 *  string (prefix/suffix/override/units/units-format/precision/
	 *  suppress-zeroes), a call to refreshDimensionText — see that method's
	 *  own doc comment for why this app must re-bake the `gr_text` value
	 *  itself rather than deriving it at paint time. */
	protected mutateDimensionSidebar(hit: BoardHit, fn: (dim: any) => void, refreshText = false): void {
		this.mutate(hit, current => {
			fn(current);
			if (refreshText) this.deps.getSession()?.refreshDimensionText(hit.id);
		});
		this.renderSidebar(hit);
	}

	/** Dialog counterpart to mutateDimensionSidebar — re-renders the DIALOG
	 *  (not the sidebar, which may not even be showing this same hit) so the
	 *  Override Value checkbox's dependent Value input and the Preview line
	 *  both reflect the just-mutated element. */
	protected mutateDimensionDialog(hit: BoardHit, fn: (dim: any) => void, refreshText = false): void {
		this.mutate(hit, current => {
			fn(current);
			if (refreshText) this.deps.getSession()?.refreshDimensionText(hit.id);
		});
		this.deps.dialog.clear();
		this.renderDimensionDialog(hit);
	}

	/** Sidebar rows for a selected dimension — "Basic Properties" (layer/
	 *  locked) plus "Dimension Properties" (everything from real KiCad's own
	 *  Dimension Properties panel this app's data model now supports — see
	 *  KicadElementDimension's own doc comment for the file-format field
	 *  inventory this maps onto). Text styling itself (font/bold/italic/
	 *  justify/color/…) isn't duplicated here — double-clicking the label
	 *  directly opens the existing generic text dialog instead, since the
	 *  label is its own independently-selectable/draggable paint item (see
	 *  BoardPainter.buildDimension's doc comment) that already carries every
	 *  one of those as ordinary PCB_TEXT fields. */
	protected renderDimensionSidebar(hit: BoardHit): void {
		const el = hit.element;
		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutateDimensionSidebar(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutateDimensionSidebar(hit, current => current.setLocked(value)));

		const props = this.deps.panel.section('Dimension Properties');
		this.deps.panel.row(props, 'Type', el.getDimensionType() === 'orthogonal' ? 'Orthogonal' : 'Aligned');
		this.deps.panel.row(props, 'Prefix', el.getPrefix(), true,
			value => this.mutateDimensionSidebar(hit, current => current.setPrefix(value), true));
		this.deps.panel.row(props, 'Suffix', el.getSuffix(), true,
			value => this.mutateDimensionSidebar(hit, current => current.setSuffix(value), true));
		this.deps.panel.checkbox(props, 'Override value', el.getOverrideTextEnabled(),
			value => this.mutateDimensionSidebar(hit, current => current.setOverrideTextEnabled(value), true));
		if (el.getOverrideTextEnabled()) {
			this.deps.panel.row(props, 'Override text', el.getOverrideText(), true,
				value => this.mutateDimensionSidebar(hit, current => current.setOverrideText(value), true));
		}
		this.deps.panel.select(props, 'Units', el.getUnitsMode(), this.UNITS_MODE_OPTIONS,
			value => this.mutateDimensionSidebar(hit, current => current.setUnitsMode(value), true));
		this.deps.panel.select(props, 'Units format', el.getUnitsFormat(), this.UNITS_FORMAT_OPTIONS,
			value => this.mutateDimensionSidebar(hit, current => current.setUnitsFormat(value), true));
		this.deps.panel.select(props, 'Precision', String(el.getPrecision()), this.PRECISION_OPTIONS,
			value => this.mutateDimensionSidebar(hit, current => current.setPrecision(Number(value)), true));
		this.deps.panel.checkbox(props, 'Suppress trailing zeroes', el.getSuppressZeroes(),
			value => this.mutateDimensionSidebar(hit, current => current.setSuppressZeroes(value), true));
		this.deps.panel.select(props, 'Arrow direction', el.getArrowDirection(), this.ARROW_DIRECTION_OPTIONS,
			value => this.mutateDimensionSidebar(hit, current => current.setArrowDirection(value)));
		this.deps.panel.row(props, 'Crossbar height (mm)', String(el.getHeight() ?? 0), true,
			value => this.mutateDimensionSidebar(hit, current => current.setHeight(Number(value) || 0)));
		this.deps.panel.row(props, 'Extension line offset (mm)', String(el.getExtensionOffset()), true,
			value => this.mutateDimensionSidebar(hit, current => current.setExtensionOffset(Math.max(0, Number(value) || 0))));
		this.deps.panel.row(props, 'Extension line overshoot (mm)', String(el.getExtensionHeight()), true,
			value => this.mutateDimensionSidebar(hit, current => current.setExtensionHeight(Number(value) || 0)));
		this.deps.panel.row(props, 'Line thickness (mm)', String(el.getLineThickness()), true,
			value => this.mutateDimensionSidebar(hit, current => current.setLineThickness(Math.max(0, Number(value) || 0.1))));
		this.deps.panel.row(props, 'Arrow length (mm)', String(el.getArrowLength()), true,
			value => this.mutateDimensionSidebar(hit, current => current.setArrowLength(Math.max(0, Number(value) || 1.27))));
		this.deps.panel.checkbox(props, 'Keep text aligned', el.getKeepTextAligned(),
			value => this.mutateDimensionSidebar(hit, current => current.setKeepTextAligned(value)));
	}

	/** Double-click dialog for a dimension — grouped to match real KiCad's
	 *  own DIALOG_DIMENSION_PROPERTIES layout (Dimension Format / Dimension
	 *  Line; a Dimension Text group is deliberately omitted, see
	 *  renderDimensionSidebar's own doc comment for why). */
	protected renderDimensionDialog(hit: BoardHit): void {
		const el = hit.element;
		const dialog = this.deps.dialog;
		const numRow = (
			container: HTMLElement, label: string, value: string, save?: (value: string) => void, numeric = false
		) => {
			const line = dialog.row(container);
			dialog.label(line, label);
			const input = dialog.textInput(line, value, save ?? (() => {}), numeric);
			if (!save) input.disabled = true;
			return input;
		};
		const selectRow = (
			container: HTMLElement, label: string, value: string, options: { value: string; label: string }[],
			save: (value: string) => void
		) => {
			const line = dialog.row(container);
			dialog.label(line, label);
			dialog.select(line, value, options, save);
		};

		const format = dialog.section(dialog.body, 'Dimension Format');
		numRow(format, 'Value', el.getOverrideTextEnabled() ? el.getOverrideText() : this.deps.getSession()?.getDimensionMeasuredText(hit.id) ?? '',
			el.getOverrideTextEnabled() ? value => this.mutateDimensionDialog(hit, current => current.setOverrideText(value), true) : undefined);
		dialog.checkRow(format, 'Override value', el.getOverrideTextEnabled(),
			value => this.mutateDimensionDialog(hit, current => current.setOverrideTextEnabled(value), true));
		numRow(format, 'Prefix', el.getPrefix(), value => this.mutateDimensionDialog(hit, current => current.setPrefix(value), true));
		numRow(format, 'Suffix', el.getSuffix(), value => this.mutateDimensionDialog(hit, current => current.setSuffix(value), true));
		selectRow(format, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutateDimensionDialog(hit, current => current.setLayer(value)));
		selectRow(format, 'Units', el.getUnitsMode(), this.UNITS_MODE_OPTIONS,
			value => this.mutateDimensionDialog(hit, current => current.setUnitsMode(value), true));
		selectRow(format, 'Units format', el.getUnitsFormat(), this.UNITS_FORMAT_OPTIONS,
			value => this.mutateDimensionDialog(hit, current => current.setUnitsFormat(value), true));
		selectRow(format, 'Precision', String(el.getPrecision()), this.PRECISION_OPTIONS,
			value => this.mutateDimensionDialog(hit, current => current.setPrecision(Number(value)), true));
		dialog.checkRow(format, 'Suppress trailing zeroes', el.getSuppressZeroes(),
			value => this.mutateDimensionDialog(hit, current => current.setSuppressZeroes(value), true));

		const line = dialog.section(dialog.body, 'Dimension Line');
		numRow(line, 'Line thickness (mm)', String(el.getLineThickness()),
			value => this.mutateDimensionDialog(hit, current => current.setLineThickness(Math.max(0, Number(value) || 0.1))), true);
		numRow(line, 'Arrow length (mm)', String(el.getArrowLength()),
			value => this.mutateDimensionDialog(hit, current => current.setArrowLength(Math.max(0, Number(value) || 1.27))), true);
		selectRow(line, 'Arrow direction', el.getArrowDirection(), this.ARROW_DIRECTION_OPTIONS,
			value => this.mutateDimensionDialog(hit, current => current.setArrowDirection(value)));
		numRow(line, 'Extension line offset (mm)', String(el.getExtensionOffset()),
			value => this.mutateDimensionDialog(hit, current => current.setExtensionOffset(Math.max(0, Number(value) || 0))), true);
		numRow(line, 'Extension line overshoot (mm)', String(el.getExtensionHeight()),
			value => this.mutateDimensionDialog(hit, current => current.setExtensionHeight(Number(value) || 0)), true);
		dialog.checkRow(line, 'Keep text aligned with dimension', el.getKeepTextAligned(),
			value => this.mutateDimensionDialog(hit, current => current.setKeepTextAligned(value)));
	}

	/** mutate() plus a full sidebar re-render — needed since the textbox-only
	 *  rows (Knockout hidden, Border/Border style conditional on the Border
	 *  checkbox) depend on re-reading the just-mutated element, same reason
	 *  mutateZone/mutatePolygon re-render themselves. */
	protected mutateTextSidebar(hit: BoardHit, fn: (element: any) => void): void {
		this.mutate(hit, fn);
		this.renderSidebar(hit);
	}

	/** Same reasoning as mutateTextSidebar — the Margin rows only show while
	 *  Knockout is on, and Error correction only applies to QR/Micro QR. */
	protected mutateBarcodeSidebar(hit: BoardHit, fn: (element: any) => void): void {
		this.mutate(hit, fn);
		this.renderSidebar(hit);
	}

	protected readonly LINE_STYLE_OPTIONS = [
		{ value: 'default', label: 'Default' }, { value: 'solid', label: 'Solid' }, { value: 'dash', label: 'Dashed' },
		{ value: 'dot', label: 'Dotted' }, { value: 'dash_dot', label: 'Dash-Dot' }, { value: 'dash_dot_dot', label: 'Dash-Dot-Dot' }
	];

	/** Sidebar rows for a selected gr_text/fp_text/gr_text_box — same field
	 *  set as BoardTextPropertiesDialog (the double-click dialog), read/
	 *  written through the exact same accessors MainApp's
	 *  boardTextDraftFromElement/openBoardTextEditDialog already use, so
	 *  live-sidebar edits and the dialog stay behaviorally identical. */
	protected renderTextSidebar(hit: BoardHit): void {
		const el = hit.element;
		const isTextBox = el.name === 'gr_text_box';
		const font = el.getFont();
		const justify = el.getJustify();
		const origin = el.getOrigin();

		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutateTextSidebar(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutateTextSidebar(hit, current => current.setLocked(value)));

		const text = this.deps.panel.section(isTextBox ? 'Text Box' : 'Text');
		this.deps.panel.row(text, 'Text', String(el.value ?? ''), true,
			value => this.mutateTextSidebar(hit, current => { current.value = value; }));
		this.deps.panel.row(text, 'Width (mm)', String(font.width ?? 1.5), true, value => this.mutateTextSidebar(hit, current => {
			const f = current.getFont(); current.setFont(Math.max(0.01, Number(value) || f.width), f.height, f.italic, f.bold, f.thickness);
		}));
		this.deps.panel.row(text, 'Height (mm)', String(font.height ?? 1.5), true, value => this.mutateTextSidebar(hit, current => {
			const f = current.getFont(); current.setFont(f.width, Math.max(0.01, Number(value) || f.height), f.italic, f.bold, f.thickness);
		}));
		this.deps.panel.row(text, 'Thickness (mm)', String(font.thickness ?? 0.3), true, value => this.mutateTextSidebar(hit, current => {
			const f = current.getFont(); current.setFont(f.width, f.height, f.italic, f.bold, Math.max(0, Number(value) || f.thickness));
		}));
		this.deps.panel.checkbox(text, 'Bold', Boolean(font.bold), value => this.mutateTextSidebar(hit, current => {
			const f = current.getFont(); current.setFont(f.width, f.height, f.italic, value, f.thickness);
		}));
		this.deps.panel.checkbox(text, 'Italic', Boolean(font.italic), value => this.mutateTextSidebar(hit, current => {
			const f = current.getFont(); current.setFont(f.width, f.height, value, f.bold, f.thickness);
		}));
		this.deps.panel.select(text, 'Horizontal alignment',
			justify.horizontal === 'left' || justify.horizontal === 'right' ? justify.horizontal : 'middle',
			[{ value: 'left', label: 'Left' }, { value: 'middle', label: 'Center' }, { value: 'right', label: 'Right' }],
			value => this.mutateTextSidebar(hit, current => { const j = current.getJustify(); current.setJustify(value, j.vertical, j.mirrored); }));
		this.deps.panel.select(text, 'Vertical alignment',
			justify.vertical === 'top' || justify.vertical === 'bottom' ? justify.vertical : 'middle',
			[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Center' }, { value: 'bottom', label: 'Bottom' }],
			value => this.mutateTextSidebar(hit, current => { const j = current.getJustify(); current.setJustify(j.horizontal, value, j.mirrored); }));
		this.deps.panel.checkbox(text, 'Mirrored', Boolean(justify.mirrored),
			value => this.mutateTextSidebar(hit, current => { const j = current.getJustify(); current.setJustify(j.horizontal, j.vertical, value); }));
		if (!isTextBox) {
			this.deps.panel.checkbox(text, 'Knockout', Boolean(el.isKnockout?.()),
				value => this.mutateTextSidebar(hit, current => current.setKnockout(value)));
		}

		const position = this.deps.panel.section('Position');
		this.deps.panel.row(position, 'Position X (mm)', String(origin.x ?? 0), true, value => this.mutateTextSidebar(hit, current => {
			const o = current.getOrigin(); current.setOrigin(Number(value) || 0, o.y, o.rotation);
		}));
		this.deps.panel.row(position, 'Position Y (mm)', String(origin.y ?? 0), true, value => this.mutateTextSidebar(hit, current => {
			const o = current.getOrigin(); current.setOrigin(o.x, Number(value) || 0, o.rotation);
		}));
		if (isTextBox) {
			this.deps.panel.row(position, 'Orientation (deg)', String(el.getSimpleChildValue?.('angle') ?? 0), true,
				value => this.mutateTextSidebar(hit, current => current.setSimpleChild('angle', Number(value) || 0, 'numeric')));
		}
		else {
			this.deps.panel.row(position, 'Orientation (deg)', String(origin.rotation ?? 0), true, value => this.mutateTextSidebar(hit, current => {
				const o = current.getOrigin(); current.setOrigin(o.x, o.y, Number(value) || 0);
			}));
		}

		if (isTextBox) {
			const stroke = el.getStroke?.() ?? { width: 0.1, type: 'default' };
			const hasBorder = Boolean(el.getSimpleChildValue?.('border'));
			const border = this.deps.panel.section('Border');
			this.deps.panel.checkbox(border, 'Border', hasBorder,
				value => this.mutateTextSidebar(hit, current => current.setSimpleChild('border', value, 'boolean')));
			if (hasBorder) {
				this.deps.panel.row(border, 'Border width (mm)', String(stroke.width ?? 0.1), true,
					value => this.mutateTextSidebar(hit, current => current.setStroke(Math.max(0, Number(value) || 0), current.getStroke().type)));
				this.deps.panel.select(border, 'Border style', stroke.type ?? 'default', this.LINE_STYLE_OPTIONS,
					value => this.mutateTextSidebar(hit, current => current.setStroke(current.getStroke().width, value)));
			}
		}
	}

	/** Sidebar rows for a selected barcode, mirroring MainApp's
	 *  barcodeDraftFromElement/openBarcodeEditDialog field set and accessors. */
	protected renderBarcodeSidebar(hit: BoardHit): void {
		const el = hit.element;
		const origin = el.getOrigin();
		const size = el.getSize();
		const margins = el.getMargins?.() ?? { x: 0, y: 0 };
		const type = String(el.getBarcodeType?.() ?? 'qr').toLowerCase();
		const isQr = type === 'qr' || type === 'microqr';
		const knockout = Boolean(el.isKnockout?.());

		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutateBarcodeSidebar(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutateBarcodeSidebar(hit, current => current.setLocked(value)));

		const props = this.deps.panel.section('Barcode');
		this.deps.panel.row(props, 'Text', String(el.getBarcodeText?.() ?? ''), true,
			value => this.mutateBarcodeSidebar(hit, current => current.setBarcodeText(value)));
		this.deps.panel.select(props, 'Type', type, [
			{ value: 'qr', label: 'QR Code' }, { value: 'microqr', label: 'Micro QR Code' },
			{ value: 'code39', label: 'Code 39' }, { value: 'code128', label: 'Code 128' }, { value: 'datamatrix', label: 'Data Matrix' }
		], value => this.mutateBarcodeSidebar(hit, current => current.setBarcodeType(value)));
		if (isQr) {
			const ec = ['M', 'Q', 'H'].includes(String(el.getErrorCorrection?.() ?? '').toUpperCase())
				? String(el.getErrorCorrection()).toUpperCase() : 'L';
			this.deps.panel.select(props, 'Error correction', ec, [
				{ value: 'L', label: 'Low (7%)' }, { value: 'M', label: 'Medium (15%)' },
				{ value: 'Q', label: 'Quartile (25%)' }, { value: 'H', label: 'High (30%)' }
			], value => this.mutateBarcodeSidebar(hit, current => current.setErrorCorrection(value)));
		}
		this.deps.panel.checkbox(props, 'Show text', !el.isTextHidden?.(),
			value => this.mutateBarcodeSidebar(hit, current => current.setTextHidden(!value)));
		this.deps.panel.row(props, 'Text height (mm)', String(el.getTextHeight?.() ?? 1), true,
			value => this.mutateBarcodeSidebar(hit, current => current.setTextHeight(Math.max(0.01, Number(value) || 1))));
		this.deps.panel.row(props, 'Width (mm)', String(size.width ?? 40), true, value => this.mutateBarcodeSidebar(hit, current => {
			const s = current.getSize(); current.setSize(Math.max(0.01, Number(value) || s.width), s.height);
		}));
		this.deps.panel.row(props, 'Height (mm)', String(size.height ?? 40), true, value => this.mutateBarcodeSidebar(hit, current => {
			const s = current.getSize(); current.setSize(s.width, Math.max(0.01, Number(value) || s.height));
		}));
		this.deps.panel.checkbox(props, 'Knockout', knockout,
			value => this.mutateBarcodeSidebar(hit, current => current.setKnockout(value)));
		if (knockout) {
			this.deps.panel.row(props, 'Margin X (mm)', String(margins.x ?? 0), true, value => this.mutateBarcodeSidebar(hit, current => {
				const m = current.getMargins(); current.setMargins(Math.max(0, Number(value) || 0), m.y);
			}));
			this.deps.panel.row(props, 'Margin Y (mm)', String(margins.y ?? 0), true, value => this.mutateBarcodeSidebar(hit, current => {
				const m = current.getMargins(); current.setMargins(m.x, Math.max(0, Number(value) || 0));
			}));
		}

		const position = this.deps.panel.section('Position');
		this.deps.panel.row(position, 'Position X (mm)', String(origin.x ?? 0), true, value => this.mutateBarcodeSidebar(hit, current => {
			const o = current.getOrigin(); current.setOrigin(Number(value) || 0, o.y, o.rotation);
		}));
		this.deps.panel.row(position, 'Position Y (mm)', String(origin.y ?? 0), true, value => this.mutateBarcodeSidebar(hit, current => {
			const o = current.getOrigin(); current.setOrigin(o.x, Number(value) || 0, o.rotation);
		}));
		this.deps.panel.row(position, 'Orientation (deg)', String(origin.rotation ?? 0), true, value => this.mutateBarcodeSidebar(hit, current => {
			const o = current.getOrigin(); current.setOrigin(o.x, o.y, Number(value) || 0);
		}));
	}

	/** Sidebar rows for a plain gr_line/gr_arc/gr_rect/gr_circle — same
	 *  Line/Fill/Layer/Locked field set as PolygonPropertiesDialog (these
	 *  are gr_poly's siblings in real KiCad's own graphic-shape family), and
	 *  likewise geometry-free — reshaping stays point-editor-only. Fill only
	 *  applies to the closed shapes (rect/circle); an open line/arc has no
	 *  area to fill. Board-side `(fill yes|no)` is a plain attribute (unlike
	 *  schematic's nested `(fill (type ...))`), so it's read/written via
	 *  getSimpleChildValue/setSimpleChild directly — see buildGrRect's own
	 *  doc comment for why WithFill's nested-fill accessors don't apply here. */
	/** mutate() plus a full sidebar re-render — Rounded rectangle's Corner
	 *  radius row and Net's copper-layer gate are both conditional. */
	protected mutateGraphicShapeSidebar(hit: BoardHit, fn: (shape: any) => void): void {
		this.mutate(hit, fn);
		this.renderSidebar(hit);
	}

	protected renderGraphicShapeSidebar(hit: BoardHit): void {
		const el = hit.element;
		const isRect = el.name === 'gr_rect';
		const isClosed = el.name === 'gr_rect' || el.name === 'gr_circle';
		const stroke = el.getStroke();

		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutateGraphicShapeSidebar(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutate(hit, current => current.setLocked(value)));

		if (isRect) {
			const shapeSection = this.deps.panel.section('Shape');
			const cornerRadius = el.getCornerRadius();
			this.deps.panel.checkbox(shapeSection, 'Rounded rectangle', cornerRadius > 0,
				value => this.mutateGraphicShapeSidebar(hit, current => current.setCornerRadius(value ? 0.25 : 0)));
			if (cornerRadius > 0) {
				this.deps.panel.row(shapeSection, 'Corner radius (mm)', String(cornerRadius), true,
					value => this.mutate(hit, current => current.setCornerRadius(Math.max(0.01, Number(value) || 0.25))));
			}
		}

		const line = this.deps.panel.section('Line');
		this.deps.panel.row(line, 'Line width (mm)', String(stroke.width), true,
			value => this.mutate(hit, current => current.setStroke(Math.max(0, Number(value) || 0), current.getStroke().type)));
		this.deps.panel.select(line, 'Line style', stroke.type, this.LINE_STYLE_OPTIONS,
			value => this.mutate(hit, current => current.setStroke(current.getStroke().width, value)));

		if (isClosed) {
			const fillSection = this.deps.panel.section('Fill');
			this.deps.panel.select(fillSection, 'Fill', el.getFillMode(), this.FILL_MODE_OPTIONS,
				value => this.mutate(hit, current => current.setFillMode(value)));
		}

		this.renderShapeNetSection(hit, el);
	}

	/** mutate() plus a full sidebar re-render — the Border/Separators width+
	 *  style rows only show while their own enable checkbox is on. */
	protected mutateTableSidebar(hit: BoardHit, fn: (table: any) => void): void {
		this.mutate(hit, fn);
		this.renderSidebar(hit);
	}

	/** Sidebar rows for a board table — Layer/Locked plus the Border/
	 *  Separators field set KicadElementTable.getBorderSettings/
	 *  getSeparatorSettings now expose (real KiCad's own Table Properties
	 *  dialog groups these the same way, see renderTableDialog's own doc
	 *  comment). The cell-contents grid itself stays canvas-only — double-
	 *  click a cell to edit its text, same as any other text element. */
	protected renderTableSidebar(hit: BoardHit): void {
		const el = hit.element;
		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutateTableSidebar(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutateTableSidebar(hit, current => current.setLocked(value)));

		const border = el.getBorderSettings();
		const borderSection = this.deps.panel.section('Border');
		this.deps.panel.checkbox(borderSection, 'External border', border.external,
			value => this.mutateTableSidebar(hit, current => current.setBorderEnabled(value, current.getBorderSettings().header)));
		this.deps.panel.checkbox(borderSection, 'Header border', border.header,
			value => this.mutateTableSidebar(hit, current => current.setBorderEnabled(current.getBorderSettings().external, value)));
		if (border.external || border.header) {
			this.deps.panel.row(borderSection, 'Border width (mm)', String(border.width), true, value => this.mutateTableSidebar(hit, current =>
				current.setBorderStroke(Math.max(0, Number(value) || 0), current.getBorderSettings().style)));
			this.deps.panel.select(borderSection, 'Border style', border.style, this.LINE_STYLE_OPTIONS, value => this.mutateTableSidebar(hit, current =>
				current.setBorderStroke(current.getBorderSettings().width, value)));
		}

		const separators = el.getSeparatorSettings();
		const separatorsSection = this.deps.panel.section('Separators');
		this.deps.panel.checkbox(separatorsSection, 'Row lines', separators.rows,
			value => this.mutateTableSidebar(hit, current => current.setSeparatorsEnabled(value, current.getSeparatorSettings().cols)));
		this.deps.panel.checkbox(separatorsSection, 'Column lines', separators.cols,
			value => this.mutateTableSidebar(hit, current => current.setSeparatorsEnabled(current.getSeparatorSettings().rows, value)));
		if (separators.rows || separators.cols) {
			this.deps.panel.row(separatorsSection, 'Separator width (mm)', String(separators.width), true, value => this.mutateTableSidebar(hit, current =>
				current.setSeparatorsStroke(Math.max(0, Number(value) || 0), current.getSeparatorSettings().style)));
			this.deps.panel.select(separatorsSection, 'Separator style', separators.style, this.LINE_STYLE_OPTIONS, value => this.mutateTableSidebar(hit, current =>
				current.setSeparatorsStroke(current.getSeparatorSettings().width, value)));
		}
	}

	/** Sidebar rows for a board reference image — Layer/Locked plus Position
	 *  and Scale (real KiCad's own Image Properties dialog is this same
	 *  minimal set; pixel dimensions are derived from the embedded file, not
	 *  independently editable). */
	protected renderImageSidebar(hit: BoardHit): void {
		const el = hit.element;
		const origin = el.getOrigin();
		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutate(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutate(hit, current => current.setLocked(value)));

		const image = this.deps.panel.section('Image');
		this.deps.panel.row(image, 'Position X (mm)', String(origin.x ?? 0), true, value => this.mutate(hit, current => {
			const o = current.getOrigin(); current.setOrigin(Number(value) || 0, o.y, o.rotation);
		}));
		this.deps.panel.row(image, 'Position Y (mm)', String(origin.y ?? 0), true, value => this.mutate(hit, current => {
			const o = current.getOrigin(); current.setOrigin(o.x, Number(value) || 0, o.rotation);
		}));
		this.deps.panel.row(image, 'Scale', String(el.getScale() ?? 1), true,
			value => this.mutate(hit, current => current.setScale(Math.max(0.01, Number(value) || 1))));
	}

	protected readonly TARGET_SHAPE_OPTIONS = [{ value: 'plus', label: '+' }, { value: 'x', label: 'X' }];

	/** Sidebar rows for a fabrication target — real KiCad's PCB_TARGET has no
	 *  `locked` field at all (confirmed against its own parser/writer), so
	 *  Basic Properties is Layer-only here, unlike every other graphic kind. */
	protected renderTargetSidebar(hit: BoardHit): void {
		const el = hit.element;
		const origin = el.getOrigin();
		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutate(hit, current => current.setLayer(value)));

		const target = this.deps.panel.section('Target');
		this.deps.panel.select(target, 'Shape', el.getShape(), this.TARGET_SHAPE_OPTIONS,
			value => this.mutate(hit, current => current.setShape(value)));
		this.deps.panel.row(target, 'Size (mm)', String(el.getSize()), true,
			value => this.mutate(hit, current => current.setSize(Math.max(0.01, Number(value) || 5))));
		this.deps.panel.row(target, 'Line width (mm)', String(el.getWidth()), true,
			value => this.mutate(hit, current => current.setWidth(Math.max(0, Number(value) || 0.2))));
		this.deps.panel.row(target, 'Position X (mm)', String(origin.x ?? 0), true, value => this.mutate(hit, current => {
			const o = current.getOrigin(); current.setOrigin(Number(value) || 0, o.y, o.rotation);
		}));
		this.deps.panel.row(target, 'Position Y (mm)', String(origin.y ?? 0), true, value => this.mutate(hit, current => {
			const o = current.getOrigin(); current.setOrigin(o.x, Number(value) || 0, o.rotation);
		}));
	}

	/** Sidebar rows for a board-level bezier curve (gr_curve) — Layer/Locked/
	 *  Line width/style only. A curve is always an open stroke (never a
	 *  closed fillable area, matches buildCurve's own always-`filled: false`
	 *  treatment), so there's no Fill row, and geometry (the 4 control
	 *  points) stays point-editor-only like every other graphic shape here. */
	protected renderCurveSidebar(hit: BoardHit): void {
		const el = hit.element;
		const stroke = el.getStroke();
		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutate(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutate(hit, current => current.setLocked(value)));

		const line = this.deps.panel.section('Line');
		this.deps.panel.row(line, 'Line width (mm)', String(stroke.width), true,
			value => this.mutate(hit, current => current.setStroke(Math.max(0, Number(value) || 0), current.getStroke().type)));
		this.deps.panel.select(line, 'Line style', stroke.type, this.LINE_STYLE_OPTIONS,
			value => this.mutate(hit, current => current.setStroke(current.getStroke().width, value)));

		this.renderShapeNetSection(hit, el);
	}

	/** Net row shared by every graphic-shape sidebar — only shown on a
	 *  copper layer, matching real KiCad's own DIALOG_SHAPE_PROPERTIES Net
	 *  field (PCB_SHAPE genuinely carries net connectivity via
	 *  BOARD_CONNECTED_ITEM, confirmed against the real parser/writer). */
	protected renderShapeNetSection(hit: BoardHit, el: any): void {
		if (!el.getLayer().endsWith('.Cu')) return;
		const netSection = this.deps.panel.section('Net');
		const nets = this.deps.getSession()?.getBoardNets() ?? [];
		const netOptions = [{ value: '', label: '<no net>' },
			...nets.filter((net: { id: number; name: string }) => net.id !== 0 && net.name)
				.map((net: { id: number; name: string }) => ({ value: net.name, label: `${ net.id } · ${ net.name }` }))];
		this.deps.panel.select(netSection, 'Net', el.getNetName() ?? '', netOptions,
			value => this.mutate(hit, current => current.setNetName(value || null)));
	}

	/** Sidebar rows for gr_ellipse/gr_ellipse_arc — same Line/Fill/Layer/
	 *  Locked shape as renderGraphicShapeSidebar's gr_rect/gr_circle case
	 *  (real KiCad's SHAPE_T::ELLIPSE/ELLIPSE_ARC share the exact same
	 *  parser/writer as every other graphic shape). Fill only applies to the
	 *  full ellipse, not the arc variant — an open arc has no area to fill. */
	protected renderEllipseSidebar(hit: BoardHit): void {
		const el = hit.element;
		const isFullEllipse = el.name === 'gr_ellipse';
		const stroke = el.getStroke();

		const basic = this.deps.panel.section('Basic Properties');
		this.deps.panel.select(basic, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutate(hit, current => current.setLayer(value)));
		this.deps.panel.checkbox(basic, 'Locked', el.isLocked(),
			value => this.mutate(hit, current => current.setLocked(value)));

		const line = this.deps.panel.section('Line');
		this.deps.panel.row(line, 'Line width (mm)', String(stroke.width), true,
			value => this.mutate(hit, current => current.setStroke(Math.max(0, Number(value) || 0), current.getStroke().type)));
		this.deps.panel.select(line, 'Line style', stroke.type, this.LINE_STYLE_OPTIONS,
			value => this.mutate(hit, current => current.setStroke(current.getStroke().width, value)));

		if (isFullEllipse) {
			const fillSection = this.deps.panel.section('Fill');
			this.deps.panel.select(fillSection, 'Fill', el.getFillMode(), this.FILL_MODE_OPTIONS,
				value => this.mutate(hit, current => current.setFillMode(value)));
		}

		this.renderShapeNetSection(hit, el);
	}

	/** Shared row builder for the flat (no group-box) dialogs — matches real
	 *  KiCad's own shape/target/image/table Properties dialogs, none of which
	 *  use titled sections internally (see this session's dialog-layout
	 *  research); this app still wraps them in one untitled-in-spirit
	 *  'General' section for consistent modal styling with the rest of the
	 *  app, same as the generic footprint/track/via/pad dialog fallback. */
	protected dialogNumRow(
		container: HTMLElement, label: string, value: string, save?: (value: string) => void, numeric = false
	): HTMLInputElement {
		const dialog = this.deps.dialog;
		const line = dialog.row(container);
		dialog.label(line, label);
		const input = dialog.textInput(line, value, save ?? (() => {}), numeric);
		if (!save) input.disabled = true;
		return input;
	}

	protected dialogSelectRow(
		container: HTMLElement, label: string, value: string, options: { value: string; label: string }[],
		save: (value: string) => void
	): void {
		const dialog = this.deps.dialog;
		const line = dialog.row(container);
		dialog.label(line, label);
		dialog.select(line, value, options, save);
	}

	protected readonly SHAPE_FRIENDLY_NAMES: Record<string, string> = {
		gr_line: 'Line', gr_arc: 'Arc', gr_rect: 'Rectangle', gr_circle: 'Circle',
		gr_curve: 'Bezier', gr_ellipse: 'Ellipse', gr_ellipse_arc: 'Ellipse Arc',
	};

	protected readonly FILL_MODE_OPTIONS = [
		{ value: 'no', label: 'None' }, { value: 'yes', label: 'Solid' }, { value: 'hatch', label: 'Hatch' },
		{ value: 'reverse_hatch', label: 'Reverse Hatch' }, { value: 'cross_hatch', label: 'Cross-hatch' },
	];

	/** Real KiCad remembers the last-used geometry-entry tab PER SHAPE TYPE
	 *  (its own `s_lastTabForShape` static map, confirmed via this session's
	 *  dialog research) rather than per-instance — keyed by element name. */
	protected shapeDialogTab: Record<string, number> = {};

	/** mutate() plus a full DIALOG re-render — needed here because Rounded
	 *  rectangle's Corner radius row and Net's copper-layer gate are both
	 *  conditional on the just-mutated element. */
	protected mutateGraphicShapeDialog(hit: BoardHit, fn: (shape: any) => void): void {
		this.mutate(hit, fn);
		this.deps.dialog.clear();
		this.renderGraphicShapeDialog(hit);
	}

	/** Two-field row inside one geometry-tab column, e.g. the "X:"/"Y:" pair
	 *  under a "Start Point" heading, or "Width:"/"Height:" under "Size".
	 *  `onChange` receives the ONE field that actually changed as a defined
	 *  number and the other as `undefined` — callers combine it with their
	 *  own freshly-read current values to compute the full new geometry. */
	protected geometryFieldColumn(
		col: HTMLElement, heading: string, label1: string, v1: number, label2: string, v2: number,
		onChange: (a: number | undefined, b: number | undefined) => void
	): void {
		const headingEl = document.createElement('div');
		headingEl.className = 'kd-col-heading';
		headingEl.textContent = heading;
		col.appendChild(headingEl);
		this.dialogNumRow(col, label1, String(v1), value => onChange(Number(value) || 0, undefined), true);
		this.dialogNumRow(col, label2, String(v2), value => onChange(undefined, Number(value) || 0), true);
	}

	/** N side-by-side geometry-field columns (real KiCad's own geometry tabs
	 *  are always 2 columns except Arc's "By Start/Mid/End", which is 3). */
	protected geometryColumns(
		container: HTMLElement,
		columns: { heading: string; label1: string; v1: number; label2: string; v2: number; onChange: (a: number | undefined, b: number | undefined) => void }[]
	): void {
		const wrap = document.createElement('div');
		wrap.className = 'kd-columns';
		container.appendChild(wrap);
		for (const column of columns) {
			const col = document.createElement('div');
			wrap.appendChild(col);
			this.geometryFieldColumn(col, column.heading, column.label1, column.v1, column.label2, column.v2, column.onChange);
		}
	}

	protected rectGeometryTabs(hit: BoardHit): { label: string; render: (pane: HTMLElement) => void }[] {
		const el = hit.element;
		const commit = (sx: number, sy: number, ex: number, ey: number) =>
			this.mutateGraphicShapeDialog(hit, current => current.setStartEnd(sx, sy, ex, ey));
		return [
			{
				label: 'By Corners', render: pane => {
					const { start, end } = el.getStartEnd();
					this.geometryColumns(pane, [
						{ heading: 'Start Point', label1: 'X:', v1: start.x, label2: 'Y:', v2: start.y,
							onChange: (x, y) => commit(x ?? start.x, y ?? start.y, end.x, end.y) },
						{ heading: 'End Point', label1: 'X:', v1: end.x, label2: 'Y:', v2: end.y,
							onChange: (x, y) => commit(start.x, start.y, x ?? end.x, y ?? end.y) },
					]);
				},
			},
			{
				label: 'By Corner and Size', render: pane => {
					const { start, end } = el.getStartEnd();
					const w = end.x - start.x, h = end.y - start.y;
					this.geometryColumns(pane, [
						{ heading: 'Start Point', label1: 'X:', v1: start.x, label2: 'Y:', v2: start.y,
							onChange: (x, y) => { const sx = x ?? start.x, sy = y ?? start.y; commit(sx, sy, sx + w, sy + h); } },
						{ heading: 'Size', label1: 'Width:', v1: w, label2: 'Height:', v2: h,
							onChange: (nw, nh) => commit(start.x, start.y, start.x + (nw ?? w), start.y + (nh ?? h)) },
					]);
				},
			},
			{
				label: 'By Center and Size', render: pane => {
					const { start, end } = el.getStartEnd();
					const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
					const w = end.x - start.x, h = end.y - start.y;
					this.geometryColumns(pane, [
						{ heading: 'Center', label1: 'X:', v1: cx, label2: 'Y:', v2: cy, onChange: (x, y) => {
							const ncx = x ?? cx, ncy = y ?? cy;
							commit(ncx - w / 2, ncy - h / 2, ncx + w / 2, ncy + h / 2);
						} },
						{ heading: 'Size', label1: 'Width:', v1: w, label2: 'Height:', v2: h, onChange: (nw, nh) => {
							const w2 = nw ?? w, h2 = nh ?? h;
							commit(cx - w2 / 2, cy - h2 / 2, cx + w2 / 2, cy + h2 / 2);
						} },
					]);
				},
			},
		];
	}

	protected lineGeometryTabs(hit: BoardHit): { label: string; render: (pane: HTMLElement) => void }[] {
		const el = hit.element;
		const commit = (sx: number, sy: number, ex: number, ey: number) =>
			this.mutateGraphicShapeDialog(hit, current => current.setStartEnd(sx, sy, ex, ey));
		return [
			{
				label: 'By Endpoints', render: pane => {
					const { start, end } = el.getStartEnd();
					this.geometryColumns(pane, [
						{ heading: 'Start Point', label1: 'X:', v1: start.x, label2: 'Y:', v2: start.y,
							onChange: (x, y) => commit(x ?? start.x, y ?? start.y, end.x, end.y) },
						{ heading: 'End Point', label1: 'X:', v1: end.x, label2: 'Y:', v2: end.y,
							onChange: (x, y) => commit(start.x, start.y, x ?? end.x, y ?? end.y) },
					]);
				},
			},
			{
				label: 'By Length and Angle', render: pane => {
					const { start, end } = el.getStartEnd();
					const length = Math.hypot(end.x - start.x, end.y - start.y);
					const angleDeg = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
					const recompute = (newStart: { x: number; y: number }, newLength: number, newAngleDeg: number) => {
						const rad = newAngleDeg * Math.PI / 180;
						commit(newStart.x, newStart.y, newStart.x + newLength * Math.cos(rad), newStart.y + newLength * Math.sin(rad));
					};
					this.geometryColumns(pane, [
						{ heading: 'Start Point', label1: 'X:', v1: start.x, label2: 'Y:', v2: start.y,
							onChange: (x, y) => recompute({ x: x ?? start.x, y: y ?? start.y }, length, angleDeg) },
						{ heading: 'Length / Angle', label1: 'Length:', v1: length, label2: 'Angle:', v2: angleDeg,
							onChange: (l, a) => recompute(start, l ?? length, a ?? angleDeg) },
					]);
				},
			},
			{
				label: 'By Start/Midpoint', render: pane => {
					const { start, end } = el.getStartEnd();
					const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
					this.geometryColumns(pane, [
						{ heading: 'Start Point', label1: 'X:', v1: start.x, label2: 'Y:', v2: start.y, onChange: (x, y) => {
							const sx = x ?? start.x, sy = y ?? start.y;
							commit(sx, sy, 2 * mid.x - sx, 2 * mid.y - sy);
						} },
						{ heading: 'Mid Point', label1: 'X:', v1: mid.x, label2: 'Y:', v2: mid.y, onChange: (x, y) => {
							const mx = x ?? mid.x, my = y ?? mid.y;
							commit(start.x, start.y, 2 * mx - start.x, 2 * my - start.y);
						} },
					]);
				},
			},
		];
	}

	protected circleGeometryTabs(hit: BoardHit): { label: string; render: (pane: HTMLElement) => void }[] {
		const el = hit.element;
		const commit = (cx: number, cy: number, ex: number, ey: number) =>
			this.mutateGraphicShapeDialog(hit, current => { current.setCenter(cx, cy); current.setEnd(ex, ey); });
		return [
			{
				label: 'By Center/Radius', render: pane => {
					const center = el.getCenter();
					const end = el.getEnd();
					const radius = Math.hypot(end.x - center.x, end.y - center.y);
					this.geometryColumns(pane, [
						{ heading: 'Center', label1: 'X:', v1: center.x, label2: 'Y:', v2: center.y, onChange: (x, y) => {
							const ncx = x ?? center.x, ncy = y ?? center.y;
							commit(ncx, ncy, ncx + radius, ncy);
						} },
					]);
					const line = this.deps.dialog.row(pane);
					this.deps.dialog.label(line, 'Radius:');
					this.deps.dialog.textInput(line, String(radius), value => {
						const r = Math.max(0, Number(value) || 0);
						commit(center.x, center.y, center.x + r, center.y);
					}, true);
				},
			},
			{
				label: 'By Center/Point', render: pane => {
					const center = el.getCenter();
					const end = el.getEnd();
					this.geometryColumns(pane, [
						{ heading: 'Center', label1: 'X:', v1: center.x, label2: 'Y:', v2: center.y,
							onChange: (x, y) => commit(x ?? center.x, y ?? center.y, end.x, end.y) },
						{ heading: 'Point on Circle', label1: 'X:', v1: end.x, label2: 'Y:', v2: end.y,
							onChange: (x, y) => commit(center.x, center.y, x ?? end.x, y ?? end.y) },
					]);
				},
			},
		];
	}

	/** Arc's geometry is natively 3 points (start/mid/end, WithStartMidEnd) —
	 *  real KiCad also offers a "By Center/Start/Angle" tab, deferred here
	 *  since deriving it needs the same center/radius/angle math
	 *  getArcCenterRadiusAngles already does just to feed BACK into new
	 *  start/mid/end points; the native By Start/Mid/End tab this renders is
	 *  both fully real (matches the file format 1:1) and sufficient to
	 *  reshape any arc. No tab strip since there's only the one tab. */
	protected renderArcGeometrySection(hit: BoardHit, container: HTMLElement): void {
		const el = hit.element;
		const { start, mid, end } = el.getStartMidEnd();
		const commit = (sx: number, sy: number, mx: number, my: number, ex: number, ey: number) =>
			this.mutateGraphicShapeDialog(hit, current => current.setStartMidEnd(sx, sy, mx, my, ex, ey));
		const wrap = document.createElement('div');
		wrap.className = 'kd-columns';
		container.appendChild(wrap);
		const cols = [
			{ heading: 'Start Point', label1: 'X:', v1: start.x, label2: 'Y:', v2: start.y,
				onChange: (x?: number, y?: number) => commit(x ?? start.x, y ?? start.y, mid.x, mid.y, end.x, end.y) },
			{ heading: 'Mid Point', label1: 'X:', v1: mid.x, label2: 'Y:', v2: mid.y,
				onChange: (x?: number, y?: number) => commit(start.x, start.y, x ?? mid.x, y ?? mid.y, end.x, end.y) },
			{ heading: 'End Point', label1: 'X:', v1: end.x, label2: 'Y:', v2: end.y,
				onChange: (x?: number, y?: number) => commit(start.x, start.y, mid.x, mid.y, x ?? end.x, y ?? end.y) },
		];
		for (const column of cols) {
			const col = document.createElement('div');
			wrap.appendChild(col);
			this.geometryFieldColumn(col, column.heading, column.label1, column.v1, column.label2, column.v2, column.onChange);
		}
	}

	/** Curve (gr_curve, 4 bezier control points) — single native tab, no
	 *  strip, matching real KiCad's own single "Bezier Control Points" tab. */
	protected renderCurveGeometrySection(hit: BoardHit, container: HTMLElement): void {
		const el = hit.element;
		const points: { x: number; y: number }[] = el.getPoints?.() ?? [];
		if (points.length !== 4) return;
		const commit = (index: number, x: number, y: number) => this.mutateGraphicShapeDialog(hit, current => {
			const pts = current.getPoints();
			pts[index] = { x, y };
			current.setPoints(pts);
		});
		this.geometryColumns(container, [
			{ heading: 'Start Point', label1: 'X:', v1: points[0]!.x, label2: 'Y:', v2: points[0]!.y,
				onChange: (x, y) => commit(0, x ?? points[0]!.x, y ?? points[0]!.y) },
			{ heading: 'End Point', label1: 'X:', v1: points[3]!.x, label2: 'Y:', v2: points[3]!.y,
				onChange: (x, y) => commit(3, x ?? points[3]!.x, y ?? points[3]!.y) },
		]);
		this.geometryColumns(container, [
			{ heading: 'Control Point 1', label1: 'X:', v1: points[1]!.x, label2: 'Y:', v2: points[1]!.y,
				onChange: (x, y) => commit(1, x ?? points[1]!.x, y ?? points[1]!.y) },
			{ heading: 'Control Point 2', label1: 'X:', v1: points[2]!.x, label2: 'Y:', v2: points[2]!.y,
				onChange: (x, y) => commit(2, x ?? points[2]!.x, y ?? points[2]!.y) },
		]);
	}

	/** Ellipse/Ellipse Arc — single native tab (Center/Major radius/Minor
	 *  radius/Rotation, plus Start/End angle for the arc variant), matching
	 *  real KiCad's own single-tab "Ellipse"/"Elliptical Arc" pages. */
	protected renderEllipseGeometrySection(hit: BoardHit, container: HTMLElement): void {
		const el = hit.element;
		const isArc = el.name === 'gr_ellipse_arc';
		const centerNode = el.findFirstChildByName?.('center');
		const center = { x: Number(centerNode?.x ?? 0), y: Number(centerNode?.y ?? 0) };
		const readNum = (name: string, fallback: number) => {
			const value = el.getSimpleChildValue?.(name);
			return typeof value === 'number' ? value : fallback;
		};
		const major = readNum('major_radius', 5);
		const minor = readNum('minor_radius', 3);
		const rotation = readNum('rotation_angle', 0);

		this.geometryColumns(container, [
			{ heading: 'Center', label1: 'X:', v1: center.x, label2: 'Y:', v2: center.y, onChange: (x, y) =>
				this.mutateGraphicShapeDialog(hit, current => {
					const c = current.findOrCreateChildByName('center');
					c.x = x ?? center.x; c.y = y ?? center.y;
				}) },
			{ heading: 'Radii', label1: 'Major:', v1: major, label2: 'Minor:', v2: minor, onChange: (mj, mn) =>
				this.mutateGraphicShapeDialog(hit, current => {
					current.setSimpleChild('major_radius', Math.max(0.01, mj ?? major), 'numeric');
					current.setSimpleChild('minor_radius', Math.max(0.01, mn ?? minor), 'numeric');
				}) },
		]);
		const rotationRow = this.deps.dialog.row(container);
		this.deps.dialog.label(rotationRow, 'Rotation (deg):');
		this.deps.dialog.textInput(rotationRow, String(rotation), value =>
			this.mutateGraphicShapeDialog(hit, current => current.setSimpleChild('rotation_angle', Number(value) || 0, 'numeric')), true);
		if (isArc) {
			const startAngle = readNum('start_angle', 0);
			const endAngle = readNum('end_angle', 360);
			this.geometryColumns(container, [
				{ heading: 'Sweep', label1: 'Start angle:', v1: startAngle, label2: 'End angle:', v2: endAngle, onChange: (sa, ea) =>
					this.mutateGraphicShapeDialog(hit, current => {
						current.setSimpleChild('start_angle', sa ?? startAngle, 'numeric');
						current.setSimpleChild('end_angle', ea ?? endAngle, 'numeric');
					}) },
			]);
		}
	}

	/** Dispatches to the right geometry-entry tab set (or single section)
	 *  per shape kind, matching real KiCad's own DIALOG_SHAPE_PROPERTIES
	 *  notebook — see this session's dialog-layout research for the exact
	 *  real tab labels/groupings this reproduces. */
	protected renderShapeGeometry(hit: BoardHit, container: HTMLElement): void {
		const el = hit.element;
		const tabSets: Record<string, () => { label: string; render: (pane: HTMLElement) => void }[]> = {
			gr_rect: () => this.rectGeometryTabs(hit),
			gr_line: () => this.lineGeometryTabs(hit),
			gr_circle: () => this.circleGeometryTabs(hit),
		};
		const buildTabs = tabSets[el.name];
		if (buildTabs) {
			const activeIndex = this.shapeDialogTab[el.name] ?? 0;
			this.deps.dialog.tabs(container, buildTabs(), activeIndex, index => {
				this.shapeDialogTab[el.name] = index;
				this.deps.dialog.clear();
				this.renderGraphicShapeDialog(hit);
			});
			return;
		}
		if (el.name === 'gr_arc') { this.renderArcGeometrySection(hit, container); return; }
		if (el.name === 'gr_curve') { this.renderCurveGeometrySection(hit, container); return; }
		if (el.name === 'gr_ellipse' || el.name === 'gr_ellipse_arc') { this.renderEllipseGeometrySection(hit, container); return; }
	}

	/** Dialog counterpart to renderGraphicShapeSidebar/renderCurveSidebar/
	 *  renderEllipseSidebar — geometry-entry tabs (see renderShapeGeometry)
	 *  followed by the common flat rows real KiCad's own DIALOG_SHAPE_
	 *  PROPERTIES shows below its own notebook (this session's dialog-layout
	 *  research, no group boxes): Locked, Rounded rectangle + Corner radius
	 *  (RECTANGLE only), Line width, Line style, Fill (closed shapes only),
	 *  Net (copper-layer shapes only — real KiCad's PCB_SHAPE genuinely
	 *  carries net data via BOARD_CONNECTED_ITEM, confirmed against the real
	 *  parser/writer, not UI-only), Layer. Technical Layers/Solder mask is
	 *  NOT replicated — that needs the multi-layer `(layers "F.Cu" "F.Mask")`
	 *  serialization form real KiCad switches to when solder-mask-enabled
	 *  (a materially different format from every other shape's single
	 *  `(layer ...)`), deliberately deferred rather than half-built, same
	 *  reasoning as Table's cell-contents grid. */
	protected renderGraphicShapeDialog(hit: BoardHit): void {
		const el = hit.element;
		const isRect = el.name === 'gr_rect';
		const isClosed = el.name === 'gr_rect' || el.name === 'gr_circle' || el.name === 'gr_ellipse';
		const stroke = el.getStroke();

		this.renderShapeGeometry(hit, this.deps.dialog.body);

		const section = this.deps.dialog.section(this.deps.dialog.body, 'General');
		this.deps.dialog.checkRow(section, 'Locked', el.isLocked(),
			value => this.mutate(hit, current => current.setLocked(value)));

		if (isRect) {
			const cornerRadius = el.getCornerRadius();
			this.deps.dialog.checkRow(section, 'Rounded rectangle', cornerRadius > 0, value =>
				this.mutateGraphicShapeDialog(hit, current => current.setCornerRadius(value ? 0.25 : 0)));
			if (cornerRadius > 0) {
				this.dialogNumRow(section, 'Corner radius (mm)', String(cornerRadius), value =>
					this.mutate(hit, current => current.setCornerRadius(Math.max(0.01, Number(value) || 0.25))), true);
			}
		}

		this.dialogNumRow(section, 'Line width (mm)', String(stroke.width),
			value => this.mutate(hit, current => current.setStroke(Math.max(0, Number(value) || 0), current.getStroke().type)), true);
		this.dialogSelectRow(section, 'Line style', stroke.type, this.LINE_STYLE_OPTIONS,
			value => this.mutate(hit, current => current.setStroke(current.getStroke().width, value)));
		if (isClosed) {
			this.dialogSelectRow(section, 'Fill', el.getFillMode(), this.FILL_MODE_OPTIONS,
				value => this.mutate(hit, current => current.setFillMode(value)));
		}
		if (el.getLayer().endsWith('.Cu')) {
			const nets = this.deps.getSession()?.getBoardNets() ?? [];
			const netOptions = [{ value: '', label: '<no net>' },
				...nets.filter((net: { id: number; name: string }) => net.id !== 0 && net.name)
					.map((net: { id: number; name: string }) => ({ value: net.name, label: `${ net.id } · ${ net.name }` }))];
			this.dialogSelectRow(section, 'Net', el.getNetName() ?? '', netOptions,
				value => this.mutate(hit, current => current.setNetName(value || null)));
		}
		this.dialogSelectRow(section, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutateGraphicShapeDialog(hit, current => current.setLayer(value)));
	}

	/** Dialog counterpart to renderTargetSidebar — real KiCad's own
	 *  DIALOG_TARGET_PROPERTIES (confirmed via this session's research) has
	 *  ONLY these three fields: no Locked (PCB_TARGET has no such field, see
	 *  KicadElementTarget's own doc comment), no Layer, no Position — those
	 *  last two are edited by dragging on canvas in real KiCad too, not
	 *  through this dialog. */
	protected renderTargetDialog(hit: BoardHit): void {
		const el = hit.element;
		const section = this.deps.dialog.section(this.deps.dialog.body, 'General');
		this.dialogNumRow(section, 'Size (mm)', String(el.getSize()),
			value => this.mutate(hit, current => current.setSize(Math.max(0.01, Number(value) || 5))), true);
		this.dialogNumRow(section, 'Thickness (mm)', String(el.getWidth()),
			value => this.mutate(hit, current => current.setWidth(Math.max(0, Number(value) || 0.2))), true);
		this.dialogSelectRow(section, 'Shape', el.getShape(), this.TARGET_SHAPE_OPTIONS,
			value => this.mutate(hit, current => current.setShape(value)));
	}

	/** Dialog counterpart to renderImageSidebar — real KiCad's own
	 *  DIALOG_REFERENCE_IMAGE_PROPERTIES additionally has independent
	 *  Width/Height fields synced against an embedded live-preview panel's
	 *  own Scale/PPI/greyscale controls; this app's data model only tracks a
	 *  single uniform scale factor (KicadElementImage.getScale/setScale, no
	 *  width/height override, no PPI/greyscale), so Scale stands in for that
	 *  whole sub-panel here. */
	protected renderImageDialog(hit: BoardHit): void {
		const el = hit.element;
		const origin = el.getOrigin();
		const section = this.deps.dialog.section(this.deps.dialog.body, 'General');
		this.dialogNumRow(section, 'Position X (mm)', String(origin.x ?? 0), value => this.mutate(hit, current => {
			const o = current.getOrigin(); current.setOrigin(Number(value) || 0, o.y, o.rotation);
		}), true);
		this.dialogNumRow(section, 'Position Y (mm)', String(origin.y ?? 0), value => this.mutate(hit, current => {
			const o = current.getOrigin(); current.setOrigin(o.x, Number(value) || 0, o.rotation);
		}), true);
		this.dialogSelectRow(section, 'Associated layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutate(hit, current => current.setLayer(value)));
		this.dialogNumRow(section, 'Scale', String(el.getScale() ?? 1),
			value => this.mutate(hit, current => current.setScale(Math.max(0.01, Number(value) || 1))), true);
		this.deps.dialog.checkRow(section, 'Locked', el.isLocked(),
			value => this.mutate(hit, current => current.setLocked(value)));
	}

	/** Dialog counterpart to renderTableSidebar — real KiCad's own
	 *  DIALOG_TABLE_PROPERTIES (confirmed via this session's research) pairs
	 *  this exact right-column field set (Layer, Locked, External/Header
	 *  border, Border width/style, Row/Column lines, Separator width/style)
	 *  with a LEFT column of an editable spreadsheet-style cell-contents
	 *  grid — that half is a real KiCad widget with no analog in this app's
	 *  dialog framework and is intentionally not replicated; cell TEXT stays
	 *  editable the normal way (double-click the cell itself on canvas).
	 *  Real KiCad puts External border/Header border on one row and Row
	 *  lines/Column lines on another; this app's row primitive is
	 *  single-control, so they're stacked instead — same fields, same
	 *  order, just one per line. */
	protected renderTableDialog(hit: BoardHit): void {
		const el = hit.element;
		const section = this.deps.dialog.section(this.deps.dialog.body, 'General');
		this.dialogSelectRow(section, 'Layer', el.getLayer(), this.boardLayerOptions(),
			value => this.mutate(hit, current => current.setLayer(value)));
		this.deps.dialog.checkRow(section, 'Locked', el.isLocked(),
			value => this.mutate(hit, current => current.setLocked(value)));

		const border = el.getBorderSettings();
		this.deps.dialog.checkRow(section, 'External border', border.external,
			value => this.mutate(hit, current => current.setBorderEnabled(value, current.getBorderSettings().header)));
		this.deps.dialog.checkRow(section, 'Header border', border.header,
			value => this.mutate(hit, current => current.setBorderEnabled(current.getBorderSettings().external, value)));
		this.dialogNumRow(section, 'Border width (mm)', String(border.width),
			value => this.mutate(hit, current => current.setBorderStroke(Math.max(0, Number(value) || 0), current.getBorderSettings().style)), true);
		this.dialogSelectRow(section, 'Border style', border.style, this.LINE_STYLE_OPTIONS,
			value => this.mutate(hit, current => current.setBorderStroke(current.getBorderSettings().width, value)));

		const separators = el.getSeparatorSettings();
		this.deps.dialog.checkRow(section, 'Row lines', separators.rows,
			value => this.mutate(hit, current => current.setSeparatorsEnabled(value, current.getSeparatorSettings().cols)));
		this.deps.dialog.checkRow(section, 'Column lines', separators.cols,
			value => this.mutate(hit, current => current.setSeparatorsEnabled(current.getSeparatorSettings().rows, value)));
		this.dialogNumRow(section, 'Separator width (mm)', String(separators.width),
			value => this.mutate(hit, current => current.setSeparatorsStroke(Math.max(0, Number(value) || 0), current.getSeparatorSettings().style)), true);
		this.dialogSelectRow(section, 'Separator style', separators.style, this.LINE_STYLE_OPTIONS,
			value => this.mutate(hit, current => current.setSeparatorsStroke(current.getSeparatorSettings().width, value)));
	}

	protected parseLayers(value: string): string[] {
		const valid = new Set(this.copperOptions().map(option => option.value));
		const layers = value.split(',').map(layer => layer.trim()).filter(layer => valid.has(layer));
		return layers.length >= 2 ? layers : ['F.Cu', 'B.Cu'];
	}
}
