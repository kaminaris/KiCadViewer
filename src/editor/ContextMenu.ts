import type {
	AlignAxis, HitResult, KicadDirectiveLabelShape, KicadGlobalLabelShape, KicadRenderSession
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

export interface BoardContextMenuBuildOptions {
	session: KicadRenderSession;
	selectedIds: string[];
	actions: {
		zoomToSelection: (session: KicadRenderSession) => void;
		rotate: (session: KicadRenderSession, id: string) => void;
		flip: (session: KicadRenderSession, id: string) => void;
		delete: (session: KicadRenderSession, ids: string[]) => void;
		setLocked: (session: KicadRenderSession, ids: string[], locked: boolean) => void;
	};
}

/** Owns the context-menu surface, command construction, and positioning. */
export class ContextMenu {
	protected readonly element = document.getElementById('context-menu') as HTMLDivElement;
	/** Scoped to a disambiguation popup's open lifetime (see
	 *  showDisambiguation) — torn down in close() so it never outlives the
	 *  popup regardless of which path closed it (item click, outside click,
	 *  Escape, or a fresh showDisambiguation call from "Show More"). */
	protected disambiguationKeyHandler: ((e: KeyboardEvent) => void) | null = null;

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
		this.teardownDisambiguationKeys();
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

	/** KiCad-like compact menu for PCB selection. Board actions stay
	 *  deliberately separate from buildItems(): the schematic menu exposes
	 *  grouping, labels, symbols, and Place tools that have no board meaning. */
	buildBoardItems(options: BoardContextMenuBuildOptions): HTMLElement[] {
		const { session, selectedIds, actions } = options;
		if (selectedIds.length === 0) {
			return [];
		}
		const items: HTMLElement[] = [
			this.item('Zoom to Selection', () => actions.zoomToSelection(session)),
			this.separator()
		];
		const singleId = selectedIds.length === 1 ? selectedIds[0] : null;
		const singleItem = singleId
			? session.activeScene?.hitTestItems.find(item => item.id === singleId)
			: null;
		const isFootprint = singleItem?.kind === 'footprint';
		items.push(this.item('Rotate', () => actions.rotate(session, singleId!), !isFootprint));
		items.push(this.item('Flip', () => actions.flip(session, singleId!), !isFootprint));
		items.push(this.separator());
		const allLocked = selectedIds.every(id => session.isBoardElementLocked(id));
		const noneLocked = selectedIds.every(id => !session.isBoardElementLocked(id));
		items.push(this.item('Lock', () => actions.setLocked(session, selectedIds, true), allLocked));
		items.push(this.item('Unlock', () => actions.setLocked(session, selectedIds, false), noneLocked));
		items.push(this.separator());
		items.push(this.item(
			selectedIds.length > 1 ? `Delete ${ selectedIds.length } Items` : 'Delete',
			() => actions.delete(session, selectedIds)));
		return items;
	}

	/** Real-KiCad-style disambiguation popup for an ambiguous board click
	 *  (see KicadRenderSession.hitTestCandidatesAtScreen) — numbered rows
	 *  (1-9, also pickable by digit key), "Select All", and "Show More
	 *  Choices…" (re-opens using the unreduced `all` list; only shown when
	 *  reduction actually dropped something). Reuses show()/close() as-is;
	 *  `all === reduced` (the "Show More" re-open) simply omits that row. */
	showDisambiguation(
		reduced: HitResult[], all: HitResult[],
		actions: { pick: (candidate: HitResult) => void; selectAll: (candidates: HitResult[]) => void },
		clientX: number, clientY: number
	): void {
		this.teardownDisambiguationKeys();
		const numbered = reduced.slice(0, 9);
		const showMore = () => this.showDisambiguation(all, all, actions, clientX, clientY);
		this.show(this.buildDisambiguationItems(reduced, all, numbered, { ...actions, showMore }), clientX, clientY);
		this.disambiguationKeyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.close();
				return;
			}
			const digit = Number(e.key);
			if (Number.isInteger(digit) && digit >= 1 && digit <= numbered.length) {
				this.close();
				actions.pick(numbered[digit - 1]!);
				return;
			}
			if (e.key.toLowerCase() === 'a') {
				this.close();
				actions.selectAll(reduced);
				return;
			}
			if (e.key.toLowerCase() === 'm' && all.length > reduced.length) {
				showMore();
			}
		};
		window.addEventListener('keydown', this.disambiguationKeyHandler);
	}

	protected teardownDisambiguationKeys(): void {
		if (this.disambiguationKeyHandler) {
			window.removeEventListener('keydown', this.disambiguationKeyHandler);
			this.disambiguationKeyHandler = null;
		}
	}

	protected buildDisambiguationItems(
		reduced: HitResult[], all: HitResult[], numbered: HitResult[],
		actions: { pick: (candidate: HitResult) => void; selectAll: (candidates: HitResult[]) => void; showMore: () => void }
	): HTMLElement[] {
		const items: HTMLElement[] = numbered.map(
			(candidate, index) => this.disambiguationItem(index + 1, candidate, () => actions.pick(candidate)));
		items.push(this.separator());
		items.push(this.hintItem('Select All', 'A', () => actions.selectAll(reduced)));
		if (all.length > reduced.length) {
			items.push(this.hintItem('Show More Choices…', 'M', actions.showMore));
		}
		return items;
	}

	protected disambiguationItem(index: number, candidate: HitResult, onSelect: () => void): HTMLButtonElement {
		const badge = document.createElement('span');
		badge.className = 'badge';
		badge.textContent = String(index);
		const label = document.createElement('span');
		label.className = 'label';
		label.textContent = this.disambiguationLabel(candidate);
		return this.disambiguationRow([badge, label], onSelect);
	}

	protected hintItem(label: string, hint: string, onSelect: () => void): HTMLButtonElement {
		const labelEl = document.createElement('span');
		labelEl.className = 'label';
		labelEl.textContent = label;
		const hintEl = document.createElement('span');
		hintEl.className = 'hint';
		hintEl.textContent = hint;
		return this.disambiguationRow([labelEl, hintEl], onSelect);
	}

	protected disambiguationRow(children: HTMLElement[], onSelect: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'menu-item disambiguation-item';
		button.append(...children);
		button.addEventListener('click', () => {
			this.close();
			onSelect();
		});
		return button;
	}

	/** Real KiCad's own candidate labels include ref designators and pad
	 *  numbers (they read them straight off BOARD_ITEM::GetSelectMenuText) —
	 *  this app's board HitResult doesn't carry a footprint reference today,
	 *  so pad/footprint labels are net+layer only. A reasonable, statable
	 *  simplification rather than threading a new lookup through hitTestCandidatesAtScreen
	 *  for this cosmetic-only gap. */
	protected disambiguationLabel(candidate: HitResult): string {
		const net = candidate.netName ? ` [${ candidate.netName }]` : '';
		switch (candidate.kind) {
			case 'track':
				return `Track${ net } on ${ candidate.layer }`
					+ (candidate.length != null ? `, length ${ candidate.length.toFixed(4) } mm` : '');
			case 'via':
				return `Via${ net }`;
			case 'pad':
				return `Pad${ net } on ${ candidate.layer }`;
			case 'footprint':
				return `Footprint on ${ candidate.layer }`;
			case 'footprint-ref':
				return `Reference on ${ candidate.layer }`;
			default:
				return `Graphic on ${ candidate.layer }`;
		}
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
