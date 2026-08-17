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
	/** The right-click's own position — used only by the Shape Modification
	 *  submenu's "Create Corner" (needs a world point to find the nearest
	 *  outline edge), mirroring buildItems' identical pointer/screenToWorld
	 *  pair for its own Paste action. */
	pointer: { x: number; y: number };
	screenToWorld: (screen: { x: number; y: number }) => { x: number; y: number };
	actions: {
		zoomToSelection: (session: KicadRenderSession) => void;
		rotate: (session: KicadRenderSession, id: string) => void;
		flip: (session: KicadRenderSession, id: string) => void;
		delete: (session: KicadRenderSession, ids: string[]) => void;
		setLocked: (session: KicadRenderSession, ids: string[], locked: boolean) => void;
		/** Real KiCad's Shape Modification ▸ Create Corner (pcb_point_editor
		 *  .cpp's addCorner) — `world` is where the new vertex should land,
		 *  already resolved to the nearest point on the zone's own outline. */
		createCorner: (session: KicadRenderSession, id: string, world: { x: number; y: number }) => void;
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
	/** Belt-and-suspenders guard against the outside-close listener below
	 *  firing for the SAME event that opened the menu. The listener is
	 *  'mousedown' (not 'click' — see that field's own history): a
	 *  `contextmenu` (right-click) open never involves a 'mousedown' at all,
	 *  so this never mattered for the original right-click menu, but
	 *  showDisambiguation opens the SAME menu from a left-click 'mousedown'
	 *  — the primary defense there is BoardPointerController calling
	 *  e.stopPropagation() right after invoking showDisambiguation, which
	 *  keeps that exact event from ever reaching this window-level listener.
	 *  This flag exists in case some future caller opens the menu from a
	 *  'mousedown' without stopping propagation: cleared on show(), re-armed
	 *  one animation frame later, so only the SAME synchronous event (still
	 *  bubbling, same call stack, zero elapsed frames) is skipped — any
	 *  later mousedown, even a fast one, has always had at least one frame
	 *  pass first. */
	protected outsideClickArmed = false;

	constructor(protected readonly stage: HTMLElement) {
		// 'mousedown', not 'click': a left-click open (showDisambiguation)
		// happens ON a 'mousedown', and this needs to tell "the same
		// triggering event, still bubbling" apart from "a later, separate
		// press" — 'click' can't do that, since it fires on MOUSEUP, which
		// for a real human is tens of milliseconds after the press that
		// opened the menu (long enough that any same-tick/same-frame guard
		// has already reset), not the same synchronous event at all. That
		// mismatch was the actual bug behind an earlier, ineffective fix
		// here that tried to guard a 'click' listener with a one-frame-later
		// arm — the arm re-armed long before the real trailing click fired,
		// so it closed the menu it had just opened every time.
		window.addEventListener('mousedown', event => {
			if (this.isOpen && this.outsideClickArmed && !this.element.contains(event.target as Node)) {
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
		this.outsideClickArmed = false;
		requestAnimationFrame(() => { this.outsideClickArmed = true; });
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
		// A zone's own selection id is its bare uuid, but its hitTestItems
		// entry carries a composite id (`${uuid}:${layer}:outline`, one per
		// layer — see BoardPainter.buildZone) since a single zone can paint
		// several such items; the prefix match covers that case, matching
		// KicadRenderSession.findZoneByUuid's identical bare/composite
		// normalization on the read side.
		const singleItem = singleId
			? session.activeScene?.hitTestItems.find(item => item.id === singleId || item.id.startsWith(`${ singleId }:`))
			: null;
		const isFootprint = singleItem?.kind === 'footprint';
		items.push(this.item('Rotate', () => actions.rotate(session, singleId!), !isFootprint));
		items.push(this.item('Flip', () => actions.flip(session, singleId!), !isFootprint));
		items.push(this.separator());
		if (singleId && singleItem?.kind === 'zone') {
			items.push(this.buildShapeModificationSubmenu(session, singleId, options));
			items.push(this.separator());
		}
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

	/** Real KiCad's board right-click ▸ Shape Modification submenu — only
	 *  "Create Corner" is implemented here (this app's zone outline editor
	 *  doesn't yet support Simplify Polygons/Chamfer Corner/Edit Corners…,
	 *  the other items in real KiCad's version of this submenu), reached by
	 *  a single selected zone. Inserts the new vertex at the point on the
	 *  zone's own outline nearest the right-click that opened this menu —
	 *  see KicadRenderSession.nearestZoneOutlineInsertion's doc comment for
	 *  why that's "nearest point on an edge", not "nearest existing vertex". */
	protected buildShapeModificationSubmenu(
		session: KicadRenderSession, zoneId: string, options: BoardContextMenuBuildOptions
	): HTMLDivElement {
		const wrap = document.createElement('div');
		wrap.className = 'submenu-wrap';
		const trigger = document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'menu-item';
		trigger.textContent = 'Shape Modification ▸';
		trigger.addEventListener('click', event => {
			event.stopPropagation();
			wrap.classList.toggle('open');
		});
		const submenu = document.createElement('div');
		submenu.className = 'submenu';
		submenu.appendChild(this.item('Create Corner', () => {
			const world = options.screenToWorld(options.pointer);
			options.actions.createCorner(session, zoneId, world);
		}));
		wrap.append(trigger, submenu);
		return wrap;
	}
}
