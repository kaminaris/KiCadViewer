import { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import { BBox }               from '@kicad-render/math/BBox';

/** Fits a render session's camera to the bounding box of everything currently
 *  hit-testable in its scene, with 15% padding on each side — the shared
 *  "frame the preview" step used by the symbol chooser, the footprint
 *  chooser, and the symbol editor's own inline preview. `schScene` isn't a
 *  public field on `KicadRenderSession` (only preview code needs raw scene
 *  bboxes), hence the cast — all three original call sites already reached
 *  through it the same way before this was pulled out into one place. */
export function fitPreviewCameraToContents(session: KicadRenderSession, pad = 0.15): void {
	const items: unknown[] = (session as any).schScene?.hitTestItems ?? [];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const hitItem of items) {
		const b = (hitItem as { bbox?: { x: number; y: number; w: number; h: number } }).bbox;
		if (!b) {
			continue;
		}
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.w);
		maxY = Math.max(maxY, b.y + b.h);
	}
	if (Number.isFinite(minX) && Number.isFinite(maxX)) {
		const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY);
		const padX = width * pad, padY = height * pad;
		session.camera.bbox = new BBox(minX - padX, minY - padY, width + padX * 2, height + padY * 2);
	}
}
