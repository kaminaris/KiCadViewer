/** Makes a fixed/absolute-positioned modal draggable (via a header handle)
 *  and resizable (via a bottom-right corner handle) — used by the app's
 *  larger native-feeling dialogs (Bulk Edit Symbol Fields, Symbol/Footprint
 *  Chooser, the double-click Properties modal) so they can be moved out of
 *  the way of each other or of the content they're editing, instead of
 *  being pinned to one fixed spot on screen.
 *
 *  Modals start laid out via CSS (`inset: 4% 3%`, or `left/top:50%` +
 *  `transform: translate(-50%,-50%)` for the centered Properties modal) —
 *  the first drag/resize gesture snapshots the CURRENT on-screen box into
 *  explicit `left/top/width/height` px, clearing whatever positioning
 *  scheme (inset, transform-centering, margin) produced it, so the modal's
 *  original CSS position is what you get on every fresh open (no state
 *  persisted across opens; simpler, and matches how every other dialog in
 *  this app already resets itself on open()).
 *
 *  Uses offsetLeft/offsetTop/offsetWidth/offsetHeight, NOT
 *  getBoundingClientRect() — the former are already relative to the
 *  modal's own offsetParent, the exact coordinate space `style.left/top`
 *  needs; the latter are viewport-relative, which silently teleports the
 *  modal on the very first drag/resize the moment its offsetParent isn't
 *  flush with the viewport origin (it isn't, here). Drag/resize DELTAS
 *  (event.clientX/Y differences) are fine either way — a pixel of pointer
 *  movement is a pixel of movement in both coordinate spaces since nothing
 *  here is scaled/zoomed, only translated. */
export function makeDraggableResizable(
	modal: HTMLElement, dragHandle: HTMLElement,
	options?: { minWidth?: number; minHeight?: number }
): void {
	const minWidth = options?.minWidth ?? 420;
	const minHeight = options?.minHeight ?? 280;
	let mode: 'drag' | 'resize' | null = null;
	let startX = 0, startY = 0, startLeft = 0, startTop = 0, startW = 0, startH = 0;

	function pinToExplicitBox(): void {
		const left = modal.offsetLeft, top = modal.offsetTop, width = modal.offsetWidth, height = modal.offsetHeight;
		modal.style.inset = 'auto';
		modal.style.transform = 'none';
		modal.style.margin = '0';
		modal.style.left = `${ left }px`;
		modal.style.top = `${ top }px`;
		modal.style.width = `${ width }px`;
		modal.style.height = `${ height }px`;
	}

	function containerBounds(): { width: number; height: number } {
		const parent = modal.offsetParent as HTMLElement | null;
		return parent
			? { width: parent.clientWidth, height: parent.clientHeight }
			: { width: window.innerWidth, height: window.innerHeight };
	}

	dragHandle.style.touchAction = 'none';
	dragHandle.addEventListener('pointerdown', event => {
		// Don't start a drag from the close button or any other control
		// living in the header.
		if ((event.target as HTMLElement).closest('button')) {
			return;
		}
		pinToExplicitBox();
		mode = 'drag';
		startX = event.clientX;
		startY = event.clientY;
		startLeft = modal.offsetLeft;
		startTop = modal.offsetTop;
		try { dragHandle.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
		document.body.classList.add('modal-dragging');
		event.preventDefault();
	});
	dragHandle.addEventListener('pointermove', event => {
		if (mode !== 'drag') {
			return;
		}
		const dx = event.clientX - startX, dy = event.clientY - startY;
		const bounds = containerBounds();
		const maxLeft = bounds.width - 60, maxTop = bounds.height - 40;
		modal.style.left = `${ Math.min(Math.max(0, startLeft + dx), maxLeft) }px`;
		modal.style.top = `${ Math.min(Math.max(0, startTop + dy), maxTop) }px`;
	});
	const endDrag = () => { mode = null; document.body.classList.remove('modal-dragging'); };
	dragHandle.addEventListener('pointerup', endDrag);
	dragHandle.addEventListener('pointercancel', endDrag);

	const resizeHandle = document.createElement('div');
	resizeHandle.className = 'modal-resize-handle';
	resizeHandle.style.touchAction = 'none';
	modal.appendChild(resizeHandle);
	resizeHandle.addEventListener('pointerdown', event => {
		pinToExplicitBox();
		mode = 'resize';
		startX = event.clientX;
		startY = event.clientY;
		startW = modal.offsetWidth;
		startH = modal.offsetHeight;
		try { resizeHandle.setPointerCapture(event.pointerId); } catch { /* best-effort */ }
		document.body.classList.add('modal-dragging');
		event.preventDefault();
		event.stopPropagation();
	});
	resizeHandle.addEventListener('pointermove', event => {
		if (mode !== 'resize') {
			return;
		}
		const dx = event.clientX - startX, dy = event.clientY - startY;
		modal.style.width = `${ Math.max(minWidth, startW + dx) }px`;
		modal.style.height = `${ Math.max(minHeight, startH + dy) }px`;
	});
	resizeHandle.addEventListener('pointerup', endDrag);
	resizeHandle.addEventListener('pointercancel', endDrag);
}
