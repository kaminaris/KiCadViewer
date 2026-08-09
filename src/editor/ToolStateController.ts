import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { EditTool } from './Toolbar';

export interface ToolStateControllerDeps {
	getSession(): KicadRenderSession | null;
	getEditTool(): EditTool;
	setEditToolValue(tool: EditTool): void;
	clearSymbolPlacement(): void;
	clearLineChainStart(): void;
	clearShapeAnchor(): void;
	clearArcPoints(): void;
	clearBezierPoints(): void;
	clearRuleAreaPoints(): void;
	clearPendingShapeTracker(): void;
	endGesture(): void;
	clearPendingTableState(): void;
	hidePropertiesModal(): void;
	resetLabelShapes(): void;
	hideTextInput(): void;
	closeContextMenu(): void;
	syncToolbar(tool: EditTool): void;
	syncToolButtons(tool: EditTool): void;
	updateHint(): void;
	clearEditPreview(): void;
}

/** Owns edit-tool switching and in-progress edit gesture reset behavior. */
export class ToolStateController {
	constructor(protected readonly deps: ToolStateControllerDeps) {}

	resetEditToolState(): void {
		this.deps.clearLineChainStart();
		this.deps.clearShapeAnchor();
		this.deps.clearArcPoints();
		this.deps.clearBezierPoints();
		this.deps.clearRuleAreaPoints();
		this.deps.clearPendingShapeTracker();
		this.deps.endGesture();
		this.deps.clearPendingTableState();
		this.deps.hidePropertiesModal();
		this.deps.resetLabelShapes();
		this.deps.hideTextInput();
		this.deps.closeContextMenu();
		this.deps.clearEditPreview();
	}

	setEditTool(tool: EditTool): void {
		if (tool !== 'place-symbol') {
			this.deps.clearSymbolPlacement();
		}
		this.deps.setEditToolValue(tool);
		this.resetEditToolState();
		this.deps.syncToolbar(tool);
		this.deps.syncToolButtons(tool);
		this.deps.updateHint();
	}
}
