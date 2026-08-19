import { EditorPane } from './EditorPane';
import { el }         from './Dom';

export interface PaneStackEntry {
	id: string;
	title: string;
	content: HTMLElement;
}

/** Owns a shell's named dock regions — builds one `EditorPane` per config
 *  entry into a container it owns (reusing `.edit-left-pane`'s existing
 *  CSS), rather than discovering pre-existing `.edit-pane` elements cloned
 *  from another screen's markup. Resizable pane-splitter handles (the
 *  schematic/PCB dock's own `.pane-splitter` drag behavior, wired in
 *  `wireMainAppInteractions.ts` against `index.html`'s static markup) are
 *  a separate, still-static-markup-only feature this doesn't attempt to
 *  replicate — nothing here needs it yet. */
export class PaneStack {
	readonly element: HTMLElement;
	protected readonly panes: EditorPane[] = [];

	constructor(entries: readonly PaneStackEntry[]) {
		this.element = el('aside', { class: 'edit-left-pane' });
		for (const entry of entries) {
			const pane = new EditorPane(entry.id, entry.title, entry.content);
			this.panes.push(pane);
			this.element.appendChild(pane.element);
		}
	}

	mount(id: string, title: string, content: HTMLElement): void {
		const pane = this.panes.find(candidate => candidate.id === id);
		if (!pane) {
			throw new Error(`Editor pane ${ id } is unavailable.`);
		}
		pane.mount(title, content);
	}

	setVisible(id: string, visible: boolean): void {
		const pane = this.panes.find(candidate => candidate.id === id);
		if (!pane) {
			throw new Error(`Editor pane ${ id } is unavailable.`);
		}
		pane.setVisible(visible);
	}

	get count(): number { return this.panes.length; }
}
