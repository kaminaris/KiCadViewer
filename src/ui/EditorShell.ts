/** Shared editor frame for any standalone (non-schematic/PCB) editor screen
 *  — the symbol editor today, a future footprint editor next. Builds its
 *  own DOM from `el()` instead of cloning `#screen-editor` and disabling
 *  every control it doesn't need: that earlier approach dragged in the
 *  entire schematic/PCB menu bar and both editors' tool buttons just to
 *  reach a brand button, a breadcrumb, and three empty dock panes, and made
 *  the shell's actual shape unreadable at the call site. This reuses the
 *  same CSS classes that markup already had (`.top`, `.brand`, `.breadcrumb`,
 *  `.command-toolbar`, `.stage`, `.status-bar`, `.edit-left-pane`) so the
 *  result is a visual match without needing that markup to exist anywhere. */
import { PaneStack, type PaneStackEntry } from './PaneStack';
import { EditorStatusBar } from './EditorStatusBar';
import { EditorChrome } from './EditorChrome';
import { ToolPalette, type ToolPaletteConfig } from './ToolPalette';
import { el, svgIcon } from './Dom';

export interface EditorShellPane {
	id: string;
	title: string;
	content: HTMLElement;
}

export interface EditorShellActions {
	onBack(): void;
	onSave(): void;
	onRevert(): void;
	saveTitle: string;
	revertTitle: string;
}

export interface EditorShellConfig {
	kind: 'symbol' | 'schematic' | 'board' | 'footprint';
	panes: readonly EditorShellPane[];
	/** Optional tool rail docked to the stage's right edge, matching the
	 *  schematic/PCB editors' own 56px tools column. Omit for an editor
	 *  with no drawing tools yet (the symbol editor doesn't have any). */
	tools?: ToolPaletteConfig;
	actions: EditorShellActions;
}

const BRAND_ICON_PATHS = ['M4 5 H15 L20 10 V19 H4 Z M15 5 V10 H20', 'M8 14 H16 M12 10 V18'];
const SAVE_ICON_PATH = 'M5 4 H17 L20 7 V20 H5 Z M8 4 V10 H16 V4 M8 20 V14 H17 V20';
const REVERT_ICON_PATH = 'M12 5 A7 7 0 1 1 5.5 9 M5 4 V9 H10';

export class EditorShell {
	readonly root: HTMLElement;
	readonly stage: HTMLElement;
	readonly chrome: EditorChrome;
	readonly status: EditorStatusBar;
	readonly panes: PaneStack;
	readonly tools: ToolPalette | null;

	constructor(config: EditorShellConfig) {
		const brandIcon = svgIcon(BRAND_ICON_PATHS);
		brandIcon.classList.add('brand-mark');
		const brandButton = el('button', { type: 'button', class: 'brand', title: 'Back to Project overview' }, [
			brandIcon,
			el('span', { textContent: 'KiOnline' }),
		]);

		const saveIcon = svgIcon(SAVE_ICON_PATH);
		const saveButton = el('button', { type: 'button', class: 'toolbar-button', dataset: { chrome: 'save' } }, saveIcon);
		const revertIcon = svgIcon(REVERT_ICON_PATH);
		const revertButton = el('button', { type: 'button', class: 'toolbar-button', dataset: { chrome: 'revert' } }, revertIcon);

		const breadcrumb = el('nav', { class: 'breadcrumb' }, [
			el('span', { class: 'breadcrumb-project' }),
			el('span', { class: 'breadcrumb-sep', textContent: '/' }),
			el('span', { class: 'breadcrumb-sheet' }),
		]);

		const header = el('header', { class: 'top' }, [
			el('div', { class: 'top-title-row' }, [brandButton, breadcrumb]),
			el('div', { class: 'command-toolbar' }, [
				el('div', { class: 'toolbar-section' }, [saveButton, revertButton]),
			]),
		]);

		this.panes = new PaneStack(config.panes.map((pane): PaneStackEntry => pane));
		this.stage = el('div', { class: 'stage' });
		this.tools = config.tools ? new ToolPalette(config.tools, () => {}) : null;

		const main = el('main', { class: this.tools ? 'editor-shell-main editor-shell-main-with-tools' : 'editor-shell-main' },
			[this.panes.element, this.stage, this.tools?.element].filter((node): node is HTMLElement => !!node));

		const statusMessage = el('span', { class: 'status-message', textContent: 'Ready' });
		this.status = new EditorStatusBar(statusMessage);
		const footer = el('footer', { class: 'status-bar' }, statusMessage);

		this.root = el('div', { class: `editor-shell editor-shell-${ config.kind }` }, [header, main, footer]);
		this.chrome = new EditorChrome(this.root);
		this.bindActions(config.actions);
	}

	mountPane(pane: EditorShellPane): void {
		this.panes.mount(pane.id, pane.title, pane.content);
	}

	mount(parent: HTMLElement): void {
		parent.replaceChildren(this.root);
	}

	bindActions(actions: EditorShellActions): void {
		this.chrome.bind(actions);
	}
}
