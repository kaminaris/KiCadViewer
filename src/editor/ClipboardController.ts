import { Vec2 } from '@kicad-render/math/Vec2';
import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { AppState } from '../app/AppState';

interface ClipboardEntry {
	sourceText: string;
	x: number;
	y: number;
}

export interface ClipboardControllerCallbacks {
	snap(n: number): number;
	syncSingleSelectionBookkeeping(session: KicadRenderSession): void;
	refreshSidebar(): void;
	setStatus(message: string): void;
}

/** Owns copy/cut/paste/duplicate behavior and in-app clipboard state. */
export class ClipboardController {
	protected clipboard: ClipboardEntry[] = [];

	constructor(
		protected readonly appState: AppState,
		protected readonly cb: ClipboardControllerCallbacks
	) {}

	copyableIds(session: KicadRenderSession, ids: string[]): string[] {
		const hitItems = session.activeScene?.hitTestItems ?? [];
		return ids.filter(id => {
			const item = hitItems.find(hit => hit.id === id);
			return !!item && item.kind !== 'sheet' && !(item.kind === 'label' && (item as any).labelKind === 'sheet-pin');
		});
	}

	cutSelection(session: KicadRenderSession): void {
		const allIds = [...session.selectionIds];
		const hitItems = session.activeScene?.hitTestItems ?? [];
		const symbolCount = allIds.filter(id => hitItems.find(hit => hit.id === id)?.kind === 'symbol').length;
		const ids = this.cuttableIds(session, allIds);
		if (ids.length === 0) {
			this.cb.setStatus(symbolCount ? 'Symbols aren\'t deletable in edit mode.' : 'Nothing to cut.');
			return;
		}
		this.copySelection(session, ids);
		const removed = session.deleteElements(ids);
		if (removed) {
			this.appState.refreshSchematicText(session);
		}
		this.cb.syncSingleSelectionBookkeeping(session);
		this.cb.setStatus(symbolCount
			? `Cut ${ removed } item(s); ${ symbolCount } symbol(s) skipped (not deletable in edit mode).`
			: `Cut ${ removed } item(s).`);
		this.cb.refreshSidebar();
	}

	copySelection(session: KicadRenderSession, ids: string[]): number {
		const copied = session.copySelectionText(ids);
		const hitItems = session.activeScene?.hitTestItems ?? [];
		this.clipboard = copied.map(({ id, sourceText }) => {
			const item = hitItems.find(hit => hit.id === id);
			const anchor = this.pasteAnchor(item?.element);
			const bbox = item?.bbox;
			return { sourceText, x: anchor?.x ?? bbox?.x ?? 0, y: anchor?.y ?? bbox?.y ?? 0 };
		});
		const systemText = session.copySelectionForSystemClipboard(ids);
		if (systemText) {
			void navigator.clipboard?.writeText(systemText).catch(() => { /* best-effort only */ });
		}
		this.cb.setStatus(this.clipboard.length ? `Copied ${ this.clipboard.length } item(s).` : 'Nothing to copy.');
		return this.clipboard.length;
	}

	async pasteAtWorld(session: KicadRenderSession, targetWorld: Vec2): Promise<void> {
		const snappedTarget = new Vec2(this.cb.snap(targetWorld.x), this.cb.snap(targetWorld.y));
		let systemText: string | null = null;
		try {
			systemText = (await navigator.clipboard?.readText()) || null;
		}
		catch {
			systemText = null;
		}
		if (systemText) {
			const newIds = session.pasteSystemClipboardText(systemText, snappedTarget.x, snappedTarget.y);
			if (newIds.length > 0) {
				session.selectMultiple(newIds, 'replace');
				this.cb.syncSingleSelectionBookkeeping(session);
				this.appState.refreshSchematicText(session);
				this.cb.setStatus(`Pasted ${ newIds.length } item(s) from clipboard.`);
				this.cb.refreshSidebar();
				return;
			}
		}
		if (this.clipboard.length > 0) {
			this.pasteClipboardAt(session, snappedTarget);
		}
		else {
			this.cb.setStatus('Nothing to paste.');
		}
	}

	duplicateSelectedElements(session: KicadRenderSession): void {
		const ids = this.copyableIds(session, [...session.selectionIds]);
		if (ids.length === 0) {
			return;
		}
		const newIds = session.duplicateSelection(ids);
		if (newIds.length === 0) {
			return;
		}
		session.selectMultiple(newIds, 'replace');
		this.cb.syncSingleSelectionBookkeeping(session);
		this.appState.refreshSchematicText(session);
		this.cb.setStatus(`Duplicated ${ newIds.length } item(s).`);
		this.cb.refreshSidebar();
	}

	groupSelection(session: KicadRenderSession): void {
		const groupUuid = session.groupSelection([...session.selectionIds]);
		if (!groupUuid) return;
		this.appState.refreshSchematicText(session);
		this.cb.setStatus('Grouped selection.');
		this.cb.refreshSidebar();
	}

	ungroupSelection(session: KicadRenderSession): void {
		const removed = session.ungroupSelection([...session.selectionIds]);
		if (removed === 0) return;
		this.appState.refreshSchematicText(session);
		this.cb.setStatus(removed === 1 ? 'Ungrouped.' : `Ungrouped ${ removed } group(s).`);
		this.cb.refreshSidebar();
	}

	protected cuttableIds(session: KicadRenderSession, ids: string[]): string[] {
		const hitItems = session.activeScene?.hitTestItems ?? [];
		return this.copyableIds(session, ids).filter(id => hitItems.find(hit => hit.id === id)?.kind !== 'symbol');
	}

	protected pasteClipboardAt(session: KicadRenderSession, targetWorld: Vec2): void {
		if (!this.clipboard.length) {
			return;
		}
		const anchorX = Math.min(...this.clipboard.map(item => item.x));
		const anchorY = Math.min(...this.clipboard.map(item => item.y));
		const dx = targetWorld.x - anchorX;
		const dy = targetWorld.y - anchorY;
		const newIds = session.pasteElements(this.clipboard.map(item => ({ sourceText: item.sourceText, dx, dy })));
		if (newIds.length === 0) {
			return;
		}
		session.selectMultiple(newIds, 'replace');
		this.cb.syncSingleSelectionBookkeeping(session);
		this.appState.refreshSchematicText(session);
		this.cb.setStatus(`Pasted ${ newIds.length } item(s).`);
		this.cb.refreshSidebar();
	}

	protected pasteAnchor(element: any): { x: number; y: number } | null {
		if (typeof element?.getOrigin === 'function') {
			const origin = element.getOrigin();
			if (Number.isFinite(origin?.x) && Number.isFinite(origin?.y)) {
				return { x: origin.x, y: origin.y };
			}
		}
		if (typeof element?.getPoints === 'function') {
			const point = element.getPoints()?.[0];
			if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
				return { x: point.x, y: point.y };
			}
		}
		if (typeof element?.getStartMidEnd === 'function') {
			const point = element.getStartMidEnd()?.start;
			if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
				return { x: point.x, y: point.y };
			}
		}
		if (typeof element?.getStartEnd === 'function') {
			const point = element.getStartEnd()?.start;
			if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
				return { x: point.x, y: point.y };
			}
		}
		if (typeof element?.getCenter === 'function') {
			const point = element.getCenter();
			if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
				return { x: point.x, y: point.y };
			}
		}
		if (typeof element?.getPolyline === 'function') {
			return this.pasteAnchor(element.getPolyline());
		}
		return null;
	}
}
