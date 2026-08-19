import { el } from './Dom';

/** One named dock region in an editor workspace. Builds its own header +
 *  body DOM (a titled `<section class="edit-pane">` with a close button and
 *  a swappable content slot) — reuses the schematic dock's existing
 *  `.edit-pane`/`.edit-pane-body` CSS so it's a visual match, but no longer
 *  requires that markup to already exist somewhere to clone. */
export class EditorPane {
	readonly id: string;
	readonly element: HTMLElement;
	protected readonly headerTitle: HTMLSpanElement;
	protected body: HTMLElement;

	constructor(id: string, title: string, content: HTMLElement) {
		this.id = id;
		this.headerTitle = el('span', { textContent: title });
		const closeButton = el('button', { type: 'button' }, '×');
		closeButton.setAttribute('aria-label', 'Close');
		closeButton.addEventListener('click', () => this.setVisible(false));
		const header = el('header', {}, [this.headerTitle, closeButton]);
		this.body = content;
		this.body.classList.add('edit-pane-body');
		this.element = el('section', { class: 'edit-pane' }, [header, this.body]);
		this.element.dataset.pane = id;
	}

	mount(title: string, content: HTMLElement): void {
		this.headerTitle.textContent = title;
		content.classList.add('edit-pane-body');
		this.body.replaceWith(content);
		this.body = content;
	}

	setVisible(visible: boolean): void {
		this.element.classList.toggle('hidden', !visible);
	}
}
