import { Vec2 }                                               from '@kicad-render/math/Vec2';
import type { ResizeHandle, SelectionResizeBox, CurveAnchor } from '@kicad-render/KicadRenderSession';

export interface Pose {
	x: number;
	y: number;
	rotation: number;
}

/**
 * The select tool's nine formerly-scattered dragXxx fields as one
 * discriminated union — the same kind-tagged idiom KicadRenderSession's own
 * EditPreviewState already uses. Exactly one gesture (or 'none') is active
 * at a time.
 *
 * Two families: "absolute-position" drags ('symbol'/'label'/'sheet'/
 * 'sheet-pin', each carrying offset+startPose, moved by re-deriving an
 * absolute target position every frame) vs. 'element''s relative-delta drag
 * (re-anchors lastSnapped and applies only the incremental step each
 * frame). 'resize'/'curve'/'rect-select'/'group' are each their own bespoke
 * mechanism.
 */
export type EditGesture =
	| { kind: 'none' }
	| { kind: 'symbol'; ref: string; instanceId: string | null; offset: Vec2; startPose: Pose }
	| { kind: 'label'; id: string; offset: Vec2; startPose: Pose }
	| { kind: 'sheet'; id: string; offset: Vec2; startPose: Pose }
	| { kind: 'sheet-pin'; id: string; offset: Vec2; startPose: Pose }
	| { kind: 'element'; id: string; lastSnapped: Vec2 }
	| { kind: 'resize'; id: string; handle: Exclude<ResizeHandle, 'center'>; original: SelectionResizeBox }
	| { kind: 'curve'; id: string; anchor: CurveAnchor }
	| { kind: 'rect-select'; originWorld: Vec2; originScreen: Vec2 }
	| { kind: 'group'; lastSnapped: Vec2 };

/**
 * Owns the active edit gesture — exactly one kind (or 'none') at a time.
 * moved/undo-capture bookkeeping lives on EditorRuntimeState instead: both
 * are driven from pointer-move deltas that only the caller sees per frame,
 * not state this tracker itself could derive.
 */
export class EditGestureTracker {
	protected gesture: EditGesture = { kind: 'none' };

	get current(): EditGesture {
		return this.gesture;
	}

	get isActive(): boolean {
		return this.gesture.kind !== 'none';
	}

	begin(gesture: EditGesture): void {
		this.gesture = gesture;
	}

	/** In-place payload update for the re-anchor-every-frame kinds ('element'
	 *  and 'group''s lastSnapped). */
	update(gesture: EditGesture): void {
		this.gesture = gesture;
	}

	/** Snapshot-then-clear — callers switch on the RETURNED gesture's kind,
	 *  not on .current (already 'none' by the time they'd look). */
	end(): EditGesture {
		const finished = this.gesture;
		this.gesture = { kind: 'none' };
		return finished;
	}
}
