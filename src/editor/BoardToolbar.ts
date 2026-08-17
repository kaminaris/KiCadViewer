export type BoardTool = 'select' | 'route' | 'via' | 'line' | 'arc' | 'rect' | 'circle' | 'polygon' | 'bezier' | 'text' | 'text-box' | 'zone' | 'grid-origin' | 'drill-origin';

export interface BoardToolbarCallbacks {
	getActiveTool(): BoardTool;
	onToolClick(tool: BoardTool): void;
}

/** Small PCB-tool counterpart to Toolbar. The schematic toolbar has
 * grouping/power-kind behavior that board tools do not need, so sharing
 * that class would couple two otherwise independent editor state machines. */
export class BoardToolbar {
	readonly buttons = Array.from(
		document.querySelectorAll<HTMLButtonElement>('#board-tool-panel [data-tool]'));

	constructor(protected readonly callbacks: BoardToolbarCallbacks) {
		for (const button of this.buttons) {
			button.addEventListener('click', () => {
				const tool = button.dataset.tool as BoardTool | undefined;
				if (tool && !button.disabled) {
					this.callbacks.onToolClick(tool);
				}
			});
		}
		this.refresh();
	}

	refresh(): void {
		const active = this.callbacks.getActiveTool();
		for (const button of this.buttons) {
			button.classList.toggle('active', button.dataset.tool === active);
			button.setAttribute('aria-pressed', String(button.dataset.tool === active));
		}
	}
}
