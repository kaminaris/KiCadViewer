import type { KicadRenderSession, KicadGlobalLabelShape, KicadDirectiveLabelShape } from '@kicad-render/KicadRenderSession';
import { Vec2 }                                                                     from '@kicad-render/math/Vec2';
import type { CircuitDesignRecipe, CircuitPlacement, LockedNetlist }               from '@kicad-layout/index';
import type { KicadSchematic }                                                     from '@kicad-io/Project/KicadSchematic';
import type { AppMode }                                                            from './AppState';
import type { EditTool }                                                           from '../editor/Toolbar';
import type { ProjectContext }                                                     from './ProjectContext';

/** 'circuit-demo' was dropped — real KiCad has no such document type, and it
 *  only ever existed here as an in-page-tab-strip label (see
 *  harmonic-munching-trinket plan's Phase 0); nothing branches on it. */
export type DocumentKind = 'schematic' | 'board';

/** The single document this page load owns. A browser tab IS the "tab" now
 *  (see the harmonic-munching-trinket plan) — this class is what's left of
 *  the earlier TabDocument/WorkspaceController pair once the in-page
 *  multi-document list was collapsed away: just the per-document fields
 *  that used to be MainApp.ts module-level `let`s, with nothing left to
 *  multiplex between. */
export class ActiveDocument {
	kind: DocumentKind = 'schematic';

	session: KicadRenderSession | null = null;
	mode: AppMode = 'view';
	circuitDragMode = false;
	highlightNetEnabled = false;

	recipe: CircuitDesignRecipe | null = null;
	icSymbolText = '';
	placements: CircuitPlacement[] = [];
	placedFragment = '';
	lockedNetlist: LockedNetlist | null = null;
	selectedRef: string | null = null;
	rerouting = false;

	currentSheetNode: KicadSchematic | null = null;
	projectContext: ProjectContext | null = null;

	editTool: EditTool = 'select';
	lineChainStart: Vec2 | null = null;
	shapeAnchor: Vec2 | null = null;
	arcPoints: Vec2[] = [];
	bezierPoints: Vec2[] = [];
	ruleAreaPoints: Vec2[] = [];
	editSelectedId: string | null = null;
	editSelectedKind: string | null = null;
	currentLabelShape: KicadGlobalLabelShape = 'input';
	currentDirectiveLabelShape: KicadDirectiveLabelShape = 'round';

	schematicText = '';

	constructor(public readonly canvas: HTMLCanvasElement, public readonly canvasGl: HTMLCanvasElement) {}
}
