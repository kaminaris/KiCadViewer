import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { AppMode } from '../app/AppState';
import type { PropertyPanel } from '../ui/PropertyPanel';
import type { PropertyRenderers } from '../ui/PropertyRenderers';
import type { PropertyDialogRenderers } from '../ui/PropertyDialogRenderers';
import type { PropertiesDialog } from '../ui/PropertiesDialog';

export interface PropertiesControllerDeps {
	getSession(): KicadRenderSession | null;
	getMode(): AppMode;
	editPropertiesEl: HTMLElement;
	propertiesModalEl: HTMLDivElement;
	propertyPanel: PropertyPanel;
	propertyRenderers: PropertyRenderers;
	propertyDialogRenderers: PropertyDialogRenderers;
	propertiesDialog: PropertiesDialog;
	multiEditNames: ReadonlySet<string>;
}

/** Owns properties sidebar and properties modal rendering/refresh behavior. */
export class PropertiesController {
	constructor(protected readonly deps: PropertiesControllerDeps) {}

	renderSelectedProperties(): void {
		const session = this.deps.getSession();
		if (!session || this.deps.getMode() !== 'edit') {
			return;
		}
		if (session.selectionIds.size > 1) {
			const items = (session.activeScene?.hitTestItems ?? []).filter(item => session.selectionIds.has(item.id));
			const names = new Set(items.map(item => (item as any).element?.name));
			const [onlyName] = names;
			if (items.length > 0 && names.size === 1 && onlyName && this.deps.multiEditNames.has(onlyName)) {
				this.deps.propertyRenderers.renderMulti(
					onlyName, items.map(item => (item as any).element), items.map(item => item.id));
			}
			else {
				this.deps.editPropertiesEl.textContent = `${ session.selectionIds.size } objects selected`;
			}
			return;
		}
		const selected = session.selection;
		if (!selected) {
			this.deps.editPropertiesEl.textContent = 'No objects selected';
			return;
		}
		const hit = session.activeScene?.hitTestItems.find(item => item.id === selected);
		const element = (hit as any)?.element;
		if (!hit || !element) {
			this.deps.editPropertiesEl.textContent = 'No objects selected';
			return;
		}
		const labelKind = (hit as any).labelKind as string | undefined;
		switch (hit.kind) {
			case 'symbol':
				this.deps.propertyRenderers.renderSymbol(element, hit.kind, hit.id);
				break;
			case 'symbol-graphic':
				this.deps.propertyRenderers.renderShape(element, hit.kind, hit.id);
				break;
			case 'wire':
			case 'bus':
				this.deps.propertyRenderers.renderWireBus(element, hit.kind, hit.id);
				break;
			case 'junction':
				this.deps.propertyRenderers.renderJunction(element, hit.id);
				break;
			case 'text':
				if (element.name === 'text' || element.name === 'text_box') {
					this.deps.propertyRenderers.renderText(element, hit.id);
				}
				else {
					this.deps.editPropertiesEl.textContent = `${ hit.kind }\nID: ${ hit.id }`;
				}
				break;
			case 'label':
				this.deps.propertyRenderers.renderLabel(element, labelKind, hit.id);
				break;
			default:
				this.deps.editPropertiesEl.textContent = `${ hit.kind }\nID: ${ hit.id }`;
		}
	}

	updateEditSidebar(): void {
		const session = this.deps.getSession();
		if (!session || this.deps.getMode() !== 'edit') {
			return;
		}
		this.deps.propertyPanel.refreshSidebar(session, () => this.renderSelectedProperties());
	}

	updateUndoStackPane(): void {
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		this.deps.propertyPanel.refreshUndoStack(session);
	}

	showPropertiesModal(hitId: string): void {
		const session = this.deps.getSession();
		if (!session) {
			return;
		}
		session.select(hitId);
		this.deps.propertiesDialog.clear();
		this.deps.propertiesDialog.setTitle('Properties');
		const hit = session.activeScene?.hitTestItems.find(item => item.id === hitId);
		const element = (hit as any)?.element;
		if (!hit || !element) {
			return;
		}
		const labelKind = (hit as any).labelKind as string | undefined;
		switch (hit.kind) {
			case 'symbol':
				this.deps.propertyDialogRenderers.renderSymbol(element, hit.id);
				break;
			case 'symbol-graphic':
				this.deps.propertyDialogRenderers.renderShape(element, hit.kind, hit.id);
				break;
			case 'wire':
			case 'bus':
				this.deps.propertyDialogRenderers.renderWireBus(element, hit.kind, hit.id);
				break;
			case 'junction':
				this.deps.propertyDialogRenderers.renderJunction(element, hit.id);
				break;
			case 'text':
				if (element.name === 'text' || element.name === 'text_box') {
					this.deps.propertyDialogRenderers.renderText(element, hit.id);
				}
				break;
			case 'label':
				this.deps.propertyDialogRenderers.renderLabel(element, labelKind, hit.id);
				break;
			default:
				break;
		}
		if (!this.deps.propertiesDialog.body.children.length) {
			return;
		}
		this.deps.propertiesDialog.show();
		this.updateUndoStackPane();
	}

	closePropertiesModal(): void {
		this.deps.propertiesDialog.close();
		this.updateEditSidebar();
	}

	maybeClosePropertiesModalFromWindowClick(target: EventTarget | null): void {
		if (!this.deps.propertiesModalEl.classList.contains('hidden')
			&& target instanceof Node
			&& !this.deps.propertiesModalEl.contains(target)) {
			this.closePropertiesModal();
		}
	}
}
