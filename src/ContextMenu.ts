import type {
	AlignAxis, KicadDirectiveLabelShape, KicadGlobalLabelShape, KicadRenderSession
} from '@kicad-render/KicadRenderSession';

export interface ContextMenuToolButton {
	id: string;
	title: string;
	disabled: boolean;
	tool?: string;
}

export interface ContextMenuToolGroup {
	buttonId: string;
	members: readonly { tool: string; menuLabel: string }[];
}

export interface ContextMenuBuildOptions {
	session: KicadRenderSession;
	hit: any | null;
	selectedIds: string[];
	toolButtons: readonly ContextMenuToolButton[];
	toolGroups: readonly ContextMenuToolGroup[];
	labelShapes: readonly KicadGlobalLabelShape[];
	directiveLabelShapes: readonly KicadDirectiveLabelShape[];
	pointer: { x: number; y: number };
	screenToWorld: (screen: { x: number; y: number }) => { x: number; y: number };
	actions: {
		zoomToSelection: (session: KicadRenderSession) => void;
		align: (session: KicadRenderSession, ids: string[], axis: AlignAxis) => void;
		copy: (session: KicadRenderSession, ids: string[]) => void;
		cut: (session: KicadRenderSession) => void;
		duplicate: (session: KicadRenderSession) => void;
		group: (session: KicadRenderSession) => void;
		ungroup: (session: KicadRenderSession) => void;
		paste: (session: KicadRenderSession, world: { x: number; y: number }) => void;
		setTool: (tool: string) => void;
		startImageInsertion: () => void;
		startSymbolPlacement: () => void;
		rotate: (session: KicadRenderSession, hit: any) => void;
		tidyLabels: (session: KicadRenderSession, hit: any) => void;
		mirror: (session: KicadRenderSession, id: string, axis: 'x' | 'y') => void;
		delete: (session: KicadRenderSession, id: string) => void;
		editLabel: (id: string) => void;
		cycleLabelShape: (session: KicadRenderSession, hit: any, shapes: readonly string[]) => void;
	};
}

/** Owns the context-menu surface, command construction, and positioning. */
export class ContextMenu {
	protected readonly element = document.getElementById('context-menu') as HTMLDivElement;

	constructor(protected readonly stage: HTMLElement) {
		window.addEventListener('click', event => {
			if (this.isOpen && !this.element.contains(event.target as Node)) {
				this.close();
			}
		});
	}

	get isOpen(): boolean { return !this.element.classList.contains('hidden'); }

	close(): void {
		this.element.classList.add('hidden');
		this.element.replaceChildren();
	}

	show(items: HTMLElement[], clientX: number, clientY: number): void {
		this.element.replaceChildren(...items);
		this.element.classList.remove('hidden');
		const stageRect = this.stage.getBoundingClientRect();
		const menuRect = this.element.getBoundingClientRect();
		this.element.style.left = `${ Math.min(
			clientX - stageRect.left, Math.max(0, stageRect.width - menuRect.width)) }px`;
		this.element.style.top = `${ Math.min(
			clientY - stageRect.top, Math.max(0, stageRect.height - menuRect.height)) }px`;
	}

	buildItems(options: ContextMenuBuildOptions): HTMLElement[] {
		const { session, hit, selectedIds, actions } = options;
		const items: HTMLElement[] = [];
		if (selectedIds.length > 0) {
			items.push(this.item('Zoom to Selection', () => actions.zoomToSelection(session)));
			items.push(this.buildAlignSubmenu(session, selectedIds, actions.align));
			items.push(this.separator());
			items.push(this.item('Copy', () => actions.copy(session, selectedIds)));
			items.push(this.item('Cut', () => actions.cut(session)));
			items.push(this.item('Duplicate', () => actions.duplicate(session)));
			items.push(this.item('Group', () => actions.group(session), selectedIds.length < 2));
			items.push(this.item('Ungroup', () => actions.ungroup(session), !session.selectionHasGroup(selectedIds)));
			items.push(this.separator());
		}

		items.push(this.item('Paste', () => actions.paste(session, options.screenToWorld(options.pointer))));
		items.push(this.separator());
		if (hit) {
			if (hit.kind === 'symbol' && hit.refDesignator) {
				items.push(this.item('Rotate', () => actions.rotate(session, hit)));
				items.push(this.item('Tidy Labels', () => actions.tidyLabels(session, hit)));
				items.push(this.item('Mirror Vertically', () => actions.mirror(session, hit.id, 'x')));
				items.push(this.item('Mirror Horizontally', () => actions.mirror(session, hit.id, 'y')));
			}
			else if (hit.kind === 'label') {
				items.push(this.item('Delete', () => actions.delete(session, hit.id)));
				items.push(this.item('Edit Text…', () => actions.editLabel(hit.id)));
				if (hit.labelKind === 'global' || hit.labelKind === 'hier' || hit.labelKind === 'directive') {
					const shapes = hit.labelKind === 'directive' ? options.directiveLabelShapes : options.labelShapes;
					items.push(this.item('Cycle Shape', () => actions.cycleLabelShape(session, hit, shapes)));
				}
			}
			else {
				items.push(this.item('Delete', () => actions.delete(session, hit.id)));
			}
			items.push(this.separator());
		}
		items.push(this.buildPlaceSubmenu(options));
		return items;
	}

	protected item(label: string, onSelect: () => void, disabled = false): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'menu-item';
		button.textContent = label;
		button.disabled = disabled;
		button.addEventListener('click', () => {
			this.close();
			onSelect();
		});
		return button;
	}

	protected separator(): HTMLDivElement {
		const separator = document.createElement('div');
		separator.className = 'separator';
		return separator;
	}

	protected buildPlaceSubmenu(options: ContextMenuBuildOptions): HTMLDivElement {
		const wrap = document.createElement('div');
		wrap.className = 'submenu-wrap';
		const trigger = document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'menu-item';
		trigger.textContent = 'Place ▸';
		trigger.addEventListener('click', event => {
			event.stopPropagation();
			wrap.classList.toggle('open');
		});
		const submenu = document.createElement('div');
		submenu.className = 'submenu';
		for (const button of options.toolButtons) {
			const group = options.toolGroups.find(candidate => candidate.buttonId === button.id);
			if (group) {
				for (const member of group.members) {
					submenu.appendChild(
						this.item(member.menuLabel, () => options.actions.setTool(member.tool)));
				}
				continue;
			}
			if (!button.tool) {
				continue;
			}
			submenu.appendChild(this.item(button.title || button.tool, () => {
				if (button.tool === 'image') {
					options.actions.startImageInsertion();
				}
				else if (button.tool === 'place-symbol') {
					options.actions.startSymbolPlacement();
				}
				else {
					options.actions.setTool(button.tool!);
				}
			}, button.disabled));
		}
		wrap.append(trigger, submenu);
		return wrap;
	}

	protected buildAlignSubmenu(
		session: KicadRenderSession, ids: string[],
		align: (session: KicadRenderSession, ids: string[], axis: AlignAxis) => void
	): HTMLDivElement {
		const axes: { axis: AlignAxis; label: string }[] = [
			{ axis: 'left', label: 'Align Left' }, { axis: 'right', label: 'Align Right' },
			{ axis: 'top', label: 'Align Top' }, { axis: 'bottom', label: 'Align Bottom' },
			{ axis: 'center-x', label: 'Align Center Horizontally' },
			{ axis: 'center-y', label: 'Align Center Vertically' }
		];
		const wrap = document.createElement('div');
		wrap.className = 'submenu-wrap';
		const trigger = document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'menu-item';
		trigger.textContent = 'Align ▸';
		trigger.disabled = ids.length < 2;
		trigger.addEventListener('click', event => {
			event.stopPropagation();
			wrap.classList.toggle('open');
		});
		const submenu = document.createElement('div');
		submenu.className = 'submenu';
		for (const { axis, label } of axes) {
			submenu.appendChild(
				this.item(label, () => align(session, ids, axis), ids.length < 2));
		}
		wrap.append(trigger, submenu);
		return wrap;
	}
}
