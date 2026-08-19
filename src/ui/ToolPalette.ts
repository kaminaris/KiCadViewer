import { el, svgIcon } from './Dom';

/** One icon button in a tool rail — same `.tool-btn`/`.tool-icon` CSS every
 *  existing schematic/board toolbar already uses (`Toolbar.ts`/
 *  `BoardToolbar.ts` bind these same classes onto hand-authored `index.html`
 *  markup), so a palette built from this component is a visual drop-in
 *  match with zero new CSS. `icon` is the raw SVG path `d` data, matching
 *  the literal `<svg viewBox="0 0 24 24"><path d="..."/></svg>` markup used
 *  throughout the app (`icons.ts`, `index.html`) — pass an array for a
 *  multi-path icon. */
export interface ToolButtonConfig {
	id: string;
	label: string;
	icon: string | string[];
	viewBox?: string;
	/** Shown appended to the tooltip as "Label (Hotkey)", matching the
	 *  existing tool-btn tooltip convention (e.g. "Wire (W)"). */
	hotkey?: string;
	disabled?: boolean;
	/** Corner flag marking a button that collapses several tools, cycled via
	 *  right-click — matches `.tool-btn.cyclable`'s existing meaning
	 *  (label/power-kind/shape groups in the schematic toolbar). */
	cyclable?: boolean;
}

export class ToolButton {
	readonly id: string;
	readonly element: HTMLButtonElement;

	constructor(config: ToolButtonConfig, onActivate: (id: string) => void) {
		this.id = config.id;
		this.element = el('button', {
			type: 'button',
			class: 'tool-btn',
			title: config.hotkey ? `${ config.label } (${ config.hotkey })` : config.label,
			disabled: !!config.disabled,
			dataset: { tool: config.id },
		});
		this.element.setAttribute('aria-label', config.label);
		this.element.setAttribute('aria-pressed', 'false');
		this.element.classList.toggle('cyclable', !!config.cyclable);
		const icon = svgIcon(config.icon, config.viewBox);
		icon.classList.add('tool-icon');
		this.element.appendChild(icon);
		this.element.addEventListener('click', () => {
			if (!this.element.disabled) onActivate(this.id);
		});
	}

	setActive(active: boolean): void {
		this.element.classList.toggle('active', active);
		this.element.setAttribute('aria-pressed', String(active));
	}

	setDisabled(disabled: boolean): void {
		this.element.disabled = disabled;
	}
}

export interface ToolPaletteConfig {
	tools: readonly ToolButtonConfig[];
	label?: string;
	/** `.tool-panel`'s own layout is a vertical rail (flex-direction:
	 *  column) — pass 'horizontal' for a top/bottom bar instead, matching
	 *  `.board-aux-toolbar`'s row layout. */
	orientation?: 'vertical' | 'horizontal';
}

/** Declarative icon-button rail — the reusable version of what every editor
 *  currently hand-assembles from static `index.html` markup plus a
 *  per-editor binder class (`Toolbar`, `BoardToolbar`, `BoardToggleToolbar`,
 *  `BoardAuxToolbar`). This owns only the WIDGET (button DOM, active/
 *  disabled/cyclable visual states, click wiring) — which tool is active,
 *  hotkeys, and cycling-group state stay in each editor's own controller,
 *  same as those existing binder classes; sharing the widget doesn't
 *  require sharing the state machine (see COMPONENTS.md). */
export class ToolPalette {
	readonly element: HTMLElement;
	protected readonly buttons = new Map<string, ToolButton>();
	protected activeId: string | null = null;

	constructor(config: ToolPaletteConfig, onSelect: (id: string) => void) {
		this.element = el('aside', {
			class: config.orientation === 'horizontal' ? 'tool-panel tool-panel-horizontal' : 'tool-panel',
		});
		if (config.label) this.element.setAttribute('aria-label', config.label);
		for (const tool of config.tools) {
			const button = new ToolButton(tool, id => {
				this.setActiveTool(id);
				onSelect(id);
			});
			this.buttons.set(tool.id, button);
			this.element.appendChild(button.element);
		}
	}

	get activeTool(): string | null { return this.activeId; }

	setActiveTool(id: string | null): void {
		this.activeId = id;
		for (const [toolId, button] of this.buttons) button.setActive(toolId === id);
	}

	setToolDisabled(id: string, disabled: boolean): void {
		this.buttons.get(id)?.setDisabled(disabled);
	}
}
