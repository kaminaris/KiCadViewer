import type { KicadRenderSession, KicadGlobalLabelShape, KicadDirectiveLabelShape } from '@kicad-render/KicadRenderSession';
import { Vec2 }                                                                     from '@kicad-render/math/Vec2';
import type { CircuitDesignRecipe, CircuitPlacement, LockedNetlist }               from '@kicad-layout/index';
import type { KicadSchematic }                                                     from '@kicad-io/Project/KicadSchematic';
import type { AppMode }                                                            from './AppState';
import type { EditTool }                                                           from '../editor/Toolbar';
import type { BoardTool }                                                          from '../editor/BoardToolbar';
import type { ProjectContext }                                                     from './ProjectContext';

/** 'circuit-demo' was dropped — real KiCad has no such document type, and it
 *  only ever existed here as an in-page-tab-strip label (see
 *  harmonic-munching-trinket plan's Phase 0); nothing branches on it. */
export type DocumentKind = 'schematic' | 'board';

/** Interactive router mode — mirrors real KiCad's PNS_MODE
 *  (pns_routing_settings.h): 'highlight' (RM_MarkObstacles) never auto-
 *  avoids anything, just flags a colliding candidate path; 'shove'
 *  (RM_Shove) pushes existing same-layer tracks out of the way; 'walkaround'
 *  (RM_Walkaround) routes around the first obstacle it meets. Only one is
 *  active at a time — see BoardPointerController.computeRoutePath/
 *  attemptShove's mode gating. */
export type RouterMode = 'highlight' | 'shove' | 'walkaround';

/** Full Route → Interactive Router Settings state — field names/defaults
 *  transcribed from the real KiCad dialog (pcbnew's DIALOG_PNS_SETTINGS).
 *  Only `mode`, `allowDrcViolations`, and `removeRedundantTracks` actually
 *  change router behavior right now (see BoardPointerController and
 *  KicadRenderSession.cleanupTracks call sites); the rest are persisted so
 *  the dialog round-trips correctly but don't yet affect placement — see
 *  [[kicad-viewer-interactive-router-port]] memory for the honest scope
 *  note before assuming one of them is wired. */
export interface RouterSettings {
	mode: RouterMode;
	freeAngleMode: boolean;
	allowDrcViolations: boolean;
	shoveVias: boolean;
	jumpOverObstacles: boolean;
	removeRedundantTracks: boolean;
	optimizePadConnections: boolean;
	smoothDraggedSegments: boolean;
	optimizeEntireDraggedTrack: boolean;
	useMousePathForPosture: boolean;
	fixAllSegmentsOnClick: boolean;
}

export function defaultRouterSettings(): RouterSettings {
	return {
		mode: 'walkaround',
		freeAngleMode: false,
		allowDrcViolations: false,
		shoveVias: true,
		jumpOverObstacles: false,
		removeRedundantTracks: false,
		optimizePadConnections: true,
		smoothDraggedSegments: true,
		optimizeEntireDraggedTrack: false,
		useMousePathForPosture: true,
		fixAllSegmentsOnClick: true
	};
}

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
	activeBoardLayer = 'F.Cu';
	boardGridVisible = true;
	boardPolarCoordinates = false;
	boardAppearanceVisible = true;
	boardTool: BoardTool = 'select';
	/** Interactive router's corner-placement mode — mirrors real KiCad's
	 *  placer setting (pns_routing_settings.cpp): '45' mates the shorter
	 *  orthogonal leg with a 45° diagonal (this app's original/default
	 *  behavior), '90' is a pure right-angle L-bend, 'free' is a single
	 *  direct segment at any angle. */
	routeCornerMode: '45' | '90' | 'free' = '45';
	routerSettings: RouterSettings = defaultRouterSettings();
	/** Selected index into board.design_settings.track_widths (0 = "use
	 *  netclass width", matching real KiCad's own PCB_EDIT_FRAME index
	 *  convention exactly — see getRoutingSizes in MainApp.ts). */
	trackWidthIndex = 0;
	/** Same convention for board.design_settings.via_dimensions. */
	viaSizeIndex = 0;
	/** Real KiCad's "auto track width" / m_UseConnectedTrackWidth: when
	 *  starting or continuing a route onto an EXISTING track, use that
	 *  track's own current width instead of trackWidthIndex/net class. */
	useConnectedTrackWidth = false;
	/** Which two copper layers a newly placed via spans — real KiCad's
	 *  "Select Layer Pair" toolbar button. */
	viaLayerPair: [string, string] = ['F.Cu', 'B.Cu'];
	/** Toolbar "Override locks" toggle — see BoardPointerController's
	 *  lock-enforcement checks in onMouseDown/delete handling. */
	overrideLocks = false;

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
	boardText = '';
	filename = '';

	/** Snapshots of schematicText/boardText as of the last successful load or
	 *  save — compared against the live text to know whether the open
	 *  document has unsaved changes. Kept separate from the live text itself
	 *  (rather than diffing against project file contents) because a board
	 *  edit's commit handler already writes every keystroke straight into
	 *  the project's KicadBoard.data, so that would never look "dirty". */
	savedSchematicText = '';
	savedBoardText = '';

	get hasUnsavedSchematicChanges(): boolean {
		return this.schematicText !== this.savedSchematicText;
	}

	get hasUnsavedBoardChanges(): boolean {
		return this.boardText !== this.savedBoardText;
	}

	/** Whether the currently active document kind has unsaved edits. */
	get isDirty(): boolean {
		return this.kind === 'board' ? this.hasUnsavedBoardChanges : this.hasUnsavedSchematicChanges;
	}

	constructor(public readonly canvas: HTMLCanvasElement, public readonly canvasGl: HTMLCanvasElement) {}
}
