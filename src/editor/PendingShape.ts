import { Vec2 } from '@kicad-render/math/Vec2';

/**
 * The five formerly-scattered multi-click "in-progress shape" fields
 * (lineChainStart/shapeAnchor/arcPoints/bezierPoints/ruleAreaPoints) as one
 * discriminated union — mutually exclusive in practice (one tool active at
 * a time), always cleared together, always checked together as "is some
 * multi-click gesture in progress."
 */
export type PendingShape =
	| { kind: 'none' }
	| { kind: 'chain'; start: Vec2 }          // wire/bus multi-segment chain
	| { kind: 'anchor'; start: Vec2 }         // line/rect/circle/text-box first click
	| { kind: 'arc'; points: Vec2[] }         // 0-2 points
	| { kind: 'bezier'; points: Vec2[] }      // 0-4 points
	| { kind: 'polygon'; points: Vec2[] }     // 0-N points, closes on first-point click/double-click
	| { kind: 'rule-area'; points: Vec2[] }   // 0-N points, closes on same-point click
	| {
		kind: 'route'; netId: number | null; layer: string; corners: Vec2[];
		/** Set once, at route-start, when the "auto track width" toggle is on
		 *  and the route started by snapping onto an existing track — real
		 *  KiCad's m_UseConnectedTrackWidth: the whole route continues at that
		 *  track's own width instead of the selected default/net class for
		 *  its entire length, not just the first leg. */
		connectedWidth?: number;
	};

export class PendingShapeTracker {
	protected shape: PendingShape = { kind: 'none' };

	get current(): PendingShape {
		return this.shape;
	}

	get isActive(): boolean {
		return this.shape.kind !== 'none';
	}

	set(shape: PendingShape): void {
		this.shape = shape;
	}

	clear(): void {
		this.shape = { kind: 'none' };
	}
}
