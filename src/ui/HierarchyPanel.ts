import { KicadSchematic } from '@kicad-io/Project/KicadSchematic';
import { el }             from './Dom';

export interface HierarchyPanelCallbacks {
	getRootSheet(): KicadSchematic | null;

	getCurrentSheet(): KicadSchematic | null;

	navigateToSheet(node: KicadSchematic): void;
}

/** Real KiCad eeschema's Hierarchy Navigator (View > Panels > Hierarchy) —
 *  a collapsible tree of a project's sheet hierarchy with click-to-navigate,
 *  mounted into `#left-dock` alongside Properties/Undo Stack/Selection
 *  Filter. Deliberately NOT virtualized like `LibraryTreeList` — real
 *  designs rarely have more than a few dozen sheets (unlike a symbol
 *  library's hundreds of entries), so a plain recursive render is simpler
 *  and cheap enough. `KicadProject.mainSchematic` (loaded once at project-
 *  open time, see `KicadSchematic.loadFromPath`) already IS the full tree —
 *  this class only renders it and tracks collapse state, no data of its own. */
export class HierarchyPanel {
	protected readonly collapsed = new Set<string>();

	constructor(protected readonly container: HTMLElement, protected readonly callbacks: HierarchyPanelCallbacks) {
	}

	refresh(): void {
		this.container.replaceChildren();
		const root = this.callbacks.getRootSheet();
		if (!root) {
			this.container.append(el('div', { class: 'hierarchy-empty' }, 'No project hierarchy available.'));
			return;
		}
		const current = this.callbacks.getCurrentSheet();
		this.container.append(this.buildNode(root, current, 0));
	}

	protected buildNode(node: KicadSchematic, current: KicadSchematic | null, depth: number): HTMLElement {
		const key = node.path || node.name;
		const hasChildren = node.sheets.length > 0;
		const isCollapsed = this.collapsed.has(key);
		const caret = el('span', { class: 'hierarchy-caret' }, hasChildren ? (isCollapsed ? '▸' : '▾') : '');
		const label = el('span', { class: 'hierarchy-label' }, node.name || node.path || '(unnamed)');
		const row = el('div', {
			class: `hierarchy-row${ node === current ? ' active' : '' }`,
			style: { paddingLeft: `${ 6 + depth * 16 }px` }
		}, [caret, label]);
		row.addEventListener('click', event => {
			if (hasChildren && event.target === caret) {
				if (isCollapsed) {
					this.collapsed.delete(key);
				}
				else {
					this.collapsed.add(key);
				}
				this.refresh();
				return;
			}
			this.callbacks.navigateToSheet(node);
		});
		const wrapper = el('div', { class: 'hierarchy-node' }, row);
		if (hasChildren && !isCollapsed) {
			for (const child of node.sheets) {
				wrapper.append(this.buildNode(child, current, depth + 1));
			}
		}
		return wrapper;
	}
}
