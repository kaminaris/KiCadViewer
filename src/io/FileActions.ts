import { Vec2 } from '@kicad-render/math/Vec2';
import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { AppMode } from '../AppState';

export interface EmbeddedImagePayload {
	data: string;
	mimeType: 'image/png' | 'image/jpeg' | 'image/gif';
}

export interface FileActionsCallbacks {
	getMode(): AppMode;
	getSession(): KicadRenderSession | null;
	getLastPointerWorld(): Vec2 | null;
	snap(n: number): number;
	setEditTool(tool: 'image' | 'select'): void;
	setStatus(message: string): void;
	refreshSchematicText(session: KicadRenderSession): void;
	setImageSelection(id: string): void;
	refreshSidebar(): void;
	openKiCadFile(file: File): Promise<void>;
}

/** Owns image ingestion/placement plus drop/paste file interactions. */
export class FileActions {
	protected pendingImagePayload: EmbeddedImagePayload | null = null;

	constructor(
		protected readonly imageInput: HTMLInputElement,
		protected readonly cb: FileActionsCallbacks
	) {}

	startImageInsertion(): void {
		this.cb.setEditTool('image');
		this.pendingImagePayload = null;
		this.imageInput.value = '';
		this.imageInput.click();
	}

	async handleImageInputChange(): Promise<void> {
		const file = this.imageInput.files?.[0];
		if (!file) {
			return;
		}
		try {
			this.pendingImagePayload = await this.readEmbeddedImage(file);
			this.cb.setEditTool('image');
			this.cb.setStatus(`Image loaded (${ file.name }) — click the schematic to place it.`);
		}
		catch (error) {
			this.pendingImagePayload = null;
			this.cb.setStatus(error instanceof Error ? error.message : String(error));
		}
	}

	tryPlacePendingImage(anchor: Vec2): void {
		if (!this.pendingImagePayload) {
			this.cb.setStatus('Choose an image file first.');
			this.startImageInsertion();
			return;
		}
		const payload = this.pendingImagePayload;
		this.pendingImagePayload = null;
		if (this.insertImageAt(payload, anchor)) {
			this.cb.setEditTool('select');
		}
	}

	handleWindowPaste(event: ClipboardEvent): void {
		const session = this.cb.getSession();
		if (this.cb.getMode() !== 'edit' || !session || session.documentTypeLoaded !== 'schematic') {
			return;
		}
		const target = event.target as HTMLElement | null;
		if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
			return;
		}
		const imageItem = Array.from(event.clipboardData?.items ?? []).find(item => item.type.startsWith('image/'));
		const file = imageItem?.getAsFile();
		if (!file) {
			return;
		}
		event.preventDefault();
		void this.readEmbeddedImage(file)
			.then(payload => {
				const center = this.cb.getLastPointerWorld() ?? new Vec2(session.camera.center.x, session.camera.center.y);
				this.insertImageAt(payload, new Vec2(this.cb.snap(center.x), this.cb.snap(center.y)));
			})
			.catch(error => this.cb.setStatus(error instanceof Error ? error.message : String(error)));
	}

	handleStageDrop(event: DragEvent): void {
		event.preventDefault();
		const file = event.dataTransfer?.files?.[0];
		if (!file) {
			return;
		}
		void this.cb.openKiCadFile(file);
	}

	protected insertImageAt(payload: EmbeddedImagePayload, anchor: Vec2): boolean {
		const session = this.cb.getSession();
		if (this.cb.getMode() !== 'edit' || !session || session.documentTypeLoaded !== 'schematic') {
			this.cb.setStatus('Open a schematic in Edit mode before inserting an image.');
			return false;
		}
		const id = session.addGraphicImage(anchor.x, anchor.y, payload.data, payload.mimeType);
		if (!id) {
			this.cb.setStatus('Could not insert image.');
			return false;
		}
		this.cb.refreshSchematicText(session);
		session.select(id);
		this.cb.setImageSelection(id);
		this.cb.setStatus('Added image.');
		this.cb.refreshSidebar();
		return true;
	}

	protected async readEmbeddedImage(blob: Blob): Promise<EmbeddedImagePayload> {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const isPng = bytes.length >= 8
			&& bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
			&& bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
		const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
		const isGif = bytes.length >= 6
			&& bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
			&& (bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61);
		const mimeType: EmbeddedImagePayload['mimeType'] | null = isPng
			? 'image/png'
			: isJpeg
				? 'image/jpeg'
				: isGif ? 'image/gif' : null;
		if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/gif') {
			throw new Error('Only PNG, JPEG, and GIF images are supported.');
		}
		let data = '';
		const chunkSize = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			data += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
		}
		return { data, mimeType };
	}
}
