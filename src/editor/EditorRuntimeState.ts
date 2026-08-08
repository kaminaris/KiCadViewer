import { Vec2 } from '@kicad-render/math/Vec2';

export interface DragPose {
	x: number;
	y: number;
	rotation: number;
}

/** Mutable interaction runtime state shared by pointer/edit gesture flows. */
export class EditorRuntimeState {
	draggingPan = false;
	dragStart = new Vec2(0, 0);
	dragOffset = new Vec2(0, 0);
	dragMoved = false;
	dragUndoCaptured = false;
	dragStartPose: DragPose | null = null;
	lastPointerWorld: Vec2 | null = null;
}
