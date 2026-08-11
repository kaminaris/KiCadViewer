import { Vec2 } from '@kicad-render/math/Vec2';

/** Mutable interaction runtime state shared by pointer/edit gesture flows. */
export class EditorRuntimeState {
	draggingPan = false;
	dragStart = new Vec2(0, 0);
	dragMoved = false;
	dragUndoCaptured = false;
	lastPointerWorld: Vec2 | null = null;
}
