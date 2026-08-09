import { LABEL_TOOL_ICONS, POWER_KIND_ICONS, SHAPE_TOOL_ICONS } from '../icons';
import type { Settings }                                        from '../app/Settings';

export type EditTool =
	| 'select'
	| 'place-symbol'
	| 'wire'
	| 'bus'
	| 'bus-entry'
	| 'junction'
	| 'no-connect'
	| 'line'
	| 'rect'
	| 'circle'
	| 'arc'
	| 'text'
	| 'text-box'
	| 'table'
	| 'rule-area'
	| 'bezier'
	| 'image'
	| 'label'
	| 'directive-label'
	| 'global-label'
	| 'hier-label'
	| 'power'
	| 'delete';
export type PowerKind = 'gnd' | 'flag' | 'rail';

export interface ToolGroupMember {
	tool: EditTool;
	menuLabel: string;
	title: string;
	icon: string;
}

export interface ToolGroupDef {
	buttonId: string;
	members: ToolGroupMember[];
}

export const EDIT_TOOL_HOTKEYS: Record<string, EditTool> = {
	s: 'select',
	w: 'wire',
	j: 'junction',
	x: 'no-connect',
	l: 'line',
	c: 'circle',
	a: 'arc',
	b: 'bezier',
	g: 'global-label',
	h: 'hier-label'
};
export const POWER_KIND_LABELS: Record<PowerKind, string> = { gnd: 'GND', flag: 'PWR_FLAG', rail: 'Rail' };
export const LABEL_GROUP: ToolGroupDef = {
	buttonId: 'btn-label-tool',
	members: [
		{
			tool: 'label',
			menuLabel: 'Label: Local',
			title: 'Label: Local — right-click to cycle Local/Directive/Global/Hierarchical',
			icon: LABEL_TOOL_ICONS.label
		},
		{
			tool: 'directive-label',
			menuLabel: 'Label: Directive',
			title: 'Label: Directive (netclass flag) — right-click to cycle · Tab cycles shape while placing',
			icon: LABEL_TOOL_ICONS['directive-label']
		},
		{
			tool: 'global-label',
			menuLabel: 'Label: Global (G)',
			title: 'Label: Global (G) — right-click to cycle · Tab cycles shape while placing',
			icon: LABEL_TOOL_ICONS['global-label']
		},
		{
			tool: 'hier-label',
			menuLabel: 'Label: Hierarchical (H)',
			title: 'Label: Hierarchical (H) — right-click to cycle · Tab cycles shape while placing',
			icon: LABEL_TOOL_ICONS['hier-label']
		}
	]
};
export const SHAPE_GROUP: ToolGroupDef = {
	buttonId: 'btn-shape-tool',
	members: [
		{ tool: 'line', menuLabel: 'Line (L)', title: 'Line (L)', icon: SHAPE_TOOL_ICONS.line },
		{ tool: 'rect', menuLabel: 'Rectangle', title: 'Rectangle', icon: SHAPE_TOOL_ICONS.rect },
		{ tool: 'circle', menuLabel: 'Circle (C)', title: 'Circle (C)', icon: SHAPE_TOOL_ICONS.circle },
		{ tool: 'arc', menuLabel: 'Arc (A)', title: 'Arc (A)', icon: SHAPE_TOOL_ICONS.arc },
		{ tool: 'bezier', menuLabel: 'Bezier Curve (B)', title: 'Bezier Curve (B)', icon: SHAPE_TOOL_ICONS.bezier }
	]
};
export const TOOL_GROUPS: ToolGroupDef[] = [LABEL_GROUP, SHAPE_GROUP];

export interface ToolbarCallbacks {
	getActiveTool(): EditTool;

	setActiveTool(tool: EditTool): void;

	onToolClick(tool: EditTool): void;

	onPowerKindChanged(): void;
}

/** Owns edit-toolbar buttons, group cycling, and the persisted power-symbol choice. */
export class Toolbar {
	readonly buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#tool-panel [data-tool]'));
	protected readonly powerButton = document.getElementById('btn-power-tool') as HTMLButtonElement;
	protected power: PowerKind;

	constructor(protected readonly settings: Settings, protected readonly callbacks: ToolbarCallbacks) {
		this.power = settings.current.powerKind;
		for (const button of this.buttons) {
			button.addEventListener('click', () => {
				const tool = button.dataset.tool as EditTool | undefined;
				if (tool) {
					this.callbacks.onToolClick(tool);
				}
			});
		}
		this.powerButton.addEventListener('contextmenu', event => {
			event.preventDefault();
			this.cyclePowerKind();
		});
		for (const group of TOOL_GROUPS) {
			const button = document.getElementById(group.buttonId) as HTMLButtonElement | null;
			if (!button) {
				continue;
			}
			this.paintGroupButton(button, group.members[0]!);
			button.addEventListener('contextmenu', event => {
				event.preventDefault();
				this.cycleGroup(group);
			});
		}
		this.paintPowerButton();
	}

	get powerKind(): PowerKind { return this.power; }

	setPowerKind(kind: PowerKind): void {
		this.power = kind;
		this.settings.setPowerKind(kind);
		this.paintPowerButton();
	}

	findGroup(tool: EditTool): ToolGroupDef | undefined {
		return TOOL_GROUPS.find(group => group.members.some(member => member.tool === tool));
	}

	syncForTool(tool: EditTool): void {
		const group = this.findGroup(tool);
		const button = group ? document.getElementById(group.buttonId) as HTMLButtonElement | null : null;
		const member = group?.members.find(item => item.tool === tool);
		if (button && member) {
			this.paintGroupButton(button, member);
		}
	}

	protected cyclePowerKind(): void {
		const kinds: PowerKind[] = ['gnd', 'flag', 'rail'];
		this.setPowerKind(kinds[(kinds.indexOf(this.power) + 1) % kinds.length]!);
		this.callbacks.onPowerKindChanged();
	}

	protected cycleGroup(group: ToolGroupDef): void {
		const button = document.getElementById(group.buttonId) as HTMLButtonElement | null;
		if (!button) {
			return;
		}
		const index = group.members.findIndex(member => member.tool === button.dataset.tool);
		const next = group.members[(index + 1) % group.members.length]!;
		if (group.members.some(member => member.tool === this.callbacks.getActiveTool())) {
			this.callbacks.setActiveTool(
				next.tool);
		}
		else {
			this.paintGroupButton(button, next);
		}
	}

	protected paintPowerButton(): void {
		const svg = this.powerButton.querySelector('svg.tool-icon');
		if (svg) {
			svg.innerHTML = POWER_KIND_ICONS[this.power];
		}
		this.powerButton.title = `Power symbol: ${ POWER_KIND_LABELS[this.power] } — right-click to cycle GND/PWR_FLAG/rail`;
	}

	protected paintGroupButton(button: HTMLButtonElement, member: ToolGroupMember): void {
		button.dataset.tool = member.tool;
		const svg = button.querySelector('svg.tool-icon');
		if (svg) {
			svg.innerHTML = member.icon;
		}
		button.title = member.title;
	}
}
