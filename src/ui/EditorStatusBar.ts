export type EditorStatusKind = 'normal' | 'dirty' | 'error';

/** Small stateful adapter around the status slot supplied by EditorShell. */
export class EditorStatusBar {
	constructor(readonly element: HTMLElement) {}

	set(message: string, kind: EditorStatusKind = 'normal'): void {
		this.element.textContent = message;
		this.element.classList.toggle('editor-status-dirty', kind === 'dirty');
		this.element.classList.toggle('editor-status-error', kind === 'error');
	}
}
