import type { EditorShellActions } from './EditorShell';

/** Shared breadcrumb and primary-action surface for standalone editors.
 *  Binds onto whatever root it's given — either the real schematic/PCB
 *  header (`MainApp.ts`, which never calls `bind()`: it only wants the
 *  breadcrumb/dirty-indicator methods, since Save/Export already have their
 *  own menu-command wiring there) or a small header `EditorShell` builds
 *  itself for a standalone editor like the symbol editor (which DOES call
 *  `bind()` to wire real click handlers). Selectors key off `data-chrome`
 *  rather than englishtitle text — title strings are copy/paste-fragile
 *  and change with the button's own tooltip wording. */
export class EditorChrome {
	readonly brandButton: HTMLButtonElement;
	readonly saveButton: HTMLButtonElement;
	readonly revertButton: HTMLButtonElement;
	protected readonly project: HTMLElement;
	protected readonly sheet: HTMLElement;

	constructor(root: HTMLElement) {
		this.brandButton = this.require(root, '.brand');
		this.project = this.require(root, '.breadcrumb-project');
		this.sheet = this.require(root, '.breadcrumb-sheet');
		this.saveButton = this.require(root, '[data-chrome="save"]');
		this.revertButton = this.require(root, '[data-chrome="revert"]');
	}

	bind(actions: EditorShellActions): void {
		this.brandButton.disabled = false;
		this.brandButton.addEventListener('click', actions.onBack);
		this.saveButton.disabled = false;
		this.saveButton.title = actions.saveTitle;
		this.saveButton.addEventListener('click', actions.onSave);
		this.revertButton.disabled = false;
		this.revertButton.title = actions.revertTitle;
		this.revertButton.addEventListener('click', actions.onRevert);
	}

	setBreadcrumb(project: string, sheet: string): void {
		this.project.textContent = project;
		this.setSheet(sheet);
	}

	setSheet(sheet: string): void {
		this.sheet.textContent = sheet;
	}

	setModified(modified: boolean): void {
		this.sheet.classList.toggle('modified', modified);
	}

	setActionsEnabled(save: boolean, revert: boolean): void {
		this.saveButton.disabled = !save;
		this.revertButton.disabled = !revert;
	}

	protected require<T extends HTMLElement>(root: HTMLElement, selector: string): T {
		const element = root.querySelector<T>(selector);
		if (!element) throw new Error(`Editor chrome control ${ selector } is unavailable.`);
		return element;
	}
}
