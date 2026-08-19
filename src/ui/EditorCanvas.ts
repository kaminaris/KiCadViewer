/** Shared ownership for an editor's visual stage. It keeps resize observers
 * local to the screen that mounted them instead of accumulating window-level
 * canvas plumbing in application wiring. */
export class EditorCanvas {
	readonly element: HTMLElement;
	protected readonly observer: ResizeObserver;

	constructor(element: HTMLElement, onResize: () => void) {
		this.element = element;
		this.observer = new ResizeObserver(onResize);
		this.observer.observe(element);
	}

	mount(...children: Node[]): void {
		this.element.replaceChildren(...children);
	}

	destroy(): void {
		this.observer.disconnect();
	}
}
