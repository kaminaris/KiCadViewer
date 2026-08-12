/** Owns the application menu's open state and declarative command forwarding. */
export class MenuBar {
	protected readonly triggers: HTMLButtonElement[];

	constructor(protected readonly element: HTMLElement) {
		this.triggers = Array.from(element.querySelectorAll<HTMLButtonElement>('.menu-trigger'));
		element.addEventListener('click', event => this.onClick(event));
		document.addEventListener('pointerdown', event => {
			if (!element.contains(event.target as Node)) {
				this.close();
			}
		});
		window.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				this.close();
			}
		});
	}

	protected onClick(event: MouseEvent): void {
		const trigger = (event.target as Element).closest<HTMLButtonElement>('.menu-trigger');
		if (trigger) {
			this.toggle(trigger);
			return;
		}
		const command = (event.target as Element).closest<HTMLButtonElement>('.menu-command');
		if (!command) {
			return;
		}
		this.run(command);
		this.close();
	}

	protected toggle(trigger: HTMLButtonElement): void {
		const willOpen = !trigger.parentElement?.classList.contains('open');
		this.close();
		trigger.parentElement?.classList.toggle('open', willOpen);
		trigger.setAttribute('aria-expanded', String(willOpen));
	}

	protected close(): void {
		for (const trigger of this.triggers) {
			trigger.parentElement?.classList.remove('open');
			trigger.setAttribute('aria-expanded', 'false');
		}
	}

	protected run(command: HTMLElement): void {
		const targetId = command.dataset.actionTarget;
		if (targetId) {
			document.getElementById(targetId)?.click();
			return;
		}
		const inputId = command.dataset.inputTarget;
		if (inputId) {
			(document.getElementById(inputId) as HTMLInputElement | null)?.click();
			return;
		}
		const tool = command.dataset.tool;
		if (tool) {
			document.querySelector<HTMLButtonElement>(`#tool-panel [data-tool="${ tool }"]`)?.click();
			return;
		}
		const shortcut = command.dataset.shortcut;
		if (shortcut) {
			this.dispatchShortcut(shortcut);
		}
	}

	protected dispatchShortcut(shortcut: string): void {
		const definition = {
			undo: { key: 'z', ctrlKey: true }, redo: { key: 'z', ctrlKey: true, shiftKey: true },
			cut: { key: 'x', ctrlKey: true }, copy: { key: 'c', ctrlKey: true },
			paste: { key: 'v', ctrlKey: true }, duplicate: { key: 'd', ctrlKey: true }, zoomFit: { key: 'Home' }
		}[shortcut === 'zoom-fit' ? 'zoomFit' : shortcut as 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'duplicate'];
		if (definition) {
			window.dispatchEvent(new KeyboardEvent('keydown', { ...definition, bubbles: true }));
		}
	}
}

/** For toolbar buttons which forward to another existing control or file input. */
export function wireToolbarCommandForwarding(): void {
	document.addEventListener('click', event => {
		const button = (event.target as Element).closest<HTMLElement>('.toolbar-button[data-action-target], .toolbar-button[data-input-target]');
		if (!button) {
			return;
		}
		const targetId = button.dataset.actionTarget ?? button.dataset.inputTarget;
		if (targetId) {
			document.getElementById(targetId)?.click();
		}
	});
}
