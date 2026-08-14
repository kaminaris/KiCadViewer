import type {
	EditPreviewState, KicadDirectiveLabelShape, KicadGlobalLabelShape, KicadRenderSession
}                        from '@kicad-render/KicadRenderSession';
import { Vec2 }          from '@kicad-render/math/Vec2';
import type { AppState } from '../app/AppState';
import type { EditTool } from './Toolbar';
import type { BoardTool } from './BoardToolbar';

type TextEntryTool = EditTool | BoardTool;

export interface TextInputFlowCallbacks {
	getSession(): KicadRenderSession | null;

	getTool(): EditTool;

	getBoardTool?(): BoardTool;

	getActiveBoardLayer?(): string;

	getHitElement(id: string): any;

	getLabelShape(): KicadGlobalLabelShape;

	setLabelShape(shape: KicadGlobalLabelShape): void;

	getDirectiveLabelShape(): KicadDirectiveLabelShape;

	setDirectiveLabelShape(shape: KicadDirectiveLabelShape): void;

	setStatus(message: string): void;

	updateHint(): void;
}

export const LABEL_SHAPES: KicadGlobalLabelShape[] = ['input', 'output', 'bidirectional', 'tri_state', 'passive'];
export const DIRECTIVE_LABEL_SHAPES: KicadDirectiveLabelShape[] = ['round', 'dot', 'diamond', 'rectangle'];
export const TEXT_INPUT_TOOLS: ReadonlySet<EditTool> = new Set<EditTool>(
	['text', 'label', 'directive-label', 'global-label', 'hier-label']);
export const TEXT_INPUT_PLACEHOLDERS: Partial<Record<EditTool, string>> = {
	text: 'Text…',
	label: 'Net name…',
	'directive-label': 'Netclass name…',
	'global-label': 'Global label…',
	'hier-label': 'Hierarchical label…',
	power: 'Voltage (e.g. +3.3V)…'
};

/** Owns floating text, text-box, and table input state and their DOM events. */
export class TextInputFlow {
	protected readonly input = document.getElementById('edit-text-input') as HTMLInputElement;
	protected readonly boxInput = document.getElementById('edit-text-box-input') as HTMLTextAreaElement;
	protected readonly tableModal = document.getElementById('table-modal') as HTMLDivElement;
	protected readonly rowsInput = document.getElementById('table-rows') as HTMLInputElement;
	protected readonly columnsInput = document.getElementById('table-columns') as HTMLInputElement;
	protected readonly dataInput = document.getElementById('table-data') as HTMLTextAreaElement;
	protected readonly stage = document.getElementById('stage')!;
	protected textAnchor: Vec2 | null = null;
	protected boxBounds: { x: number; y: number; width: number; height: number } | null = null;
	protected tableAnchor: Vec2 | null = null;
	protected tableId: string | null = null;
	protected editingLabelId: string | null = null;

	constructor(protected readonly appState: AppState, protected readonly cb: TextInputFlowCallbacks) {
		document.getElementById('table-cancel')?.addEventListener('click', () => this.cancelTable());
		document.getElementById('table-insert')?.addEventListener('click', () => this.commitTable());
		this.dataInput.addEventListener('keydown', e => this.tableKey(e));
		this.input.addEventListener('input', () => this.updateTextPreview());
		this.input.addEventListener('keydown', e => this.textKey(e));
		this.input.addEventListener('blur', () => this.textBlur());
		this.boxInput.addEventListener('input', () => this.updateBoxPreview());
		this.boxInput.addEventListener('keydown', e => this.boxKey(e));
		this.boxInput.addEventListener('blur', () => this.boxBlur());
	}

	reset(): void {
		this.tableAnchor = null;
		this.tableId = null;
		this.tableModal.classList.add('hidden');
		this.input.classList.add('hidden');
		this.input.value = '';
		this.boxInput.classList.add('hidden');
		this.boxInput.value = '';
		this.textAnchor = null;
		this.boxBounds = null;
		this.editingLabelId = null;
	}

	showText(anchor: Vec2, event: MouseEvent, placeholders: Partial<Record<TextEntryTool, string>>): void {
		const rect = this.stage.getBoundingClientRect();
		this.textAnchor = anchor;
		this.input.style.left = `${ event.clientX - rect.left }px`;
		this.input.style.top = `${ event.clientY - rect.top }px`;
		this.input.value = '';
		this.input.placeholder = placeholders[this.activeTool()] ?? '';
		this.input.classList.remove('hidden');
		this.input.focus();
		this.cb.getSession()?.setEditPreview(this.preview(anchor, ''));
	}

	showTextBox(first: Vec2, second: Vec2, event: MouseEvent): void {
		this.boxBounds = {
			x: Math.min(first.x, second.x),
			y: Math.min(first.y, second.y),
			width: Math.abs(second.x - first.x),
			height: Math.abs(second.y - first.y)
		};
		const rect = this.stage.getBoundingClientRect();
		this.boxInput.style.left = `${ event.clientX - rect.left }px`;
		this.boxInput.style.top = `${ event.clientY - rect.top }px`;
		this.boxInput.value = '';
		this.boxInput.classList.remove('hidden');
		this.boxInput.focus();
		this.cb.getSession()?.setEditPreview(this.boxPreview(''));
	}

	showTable(anchor: Vec2): void {
		this.tableAnchor = anchor;
		this.tableId = null;
		this.tableModal.classList.remove('hidden');
		this.dataInput.focus();
	}

	showTableEditor(id: string): void {
		const table = this.cb.getHitElement(id),
			cells = table?.findFirstChildByName?.('cells')?.findChildrenByName?.('table_cell') ?? [];
		if (!table || !cells.length) {
			return;
		}
		const columns = Number(table.findFirstChildByName?.('column_count')?.attributes?.[0]?.value) || 1;
		const rows = Math.max(1, Math.ceil(cells.length / columns)), origin = cells[0]?.getOrigin?.() ?? { x: 0, y: 0 };
		this.rowsInput.value = String(rows);
		this.columnsInput.value = String(columns);
		this.dataInput.value = Array.from(
			{ length: rows },
			(_, r) => Array.from({ length: columns }, (_, c) => String(cells[r * columns + c]?.value ?? '')).join('\t')
		).join('\n');
		this.tableId = id;
		this.tableAnchor = new Vec2(origin.x, origin.y);
		this.tableModal.classList.remove('hidden');
		this.dataInput.focus();
	}

	showEditLabel(id: string): void {
		const session = this.cb.getSession(), element = this.cb.getHitElement(id);
		if (!session || !element) {
			return;
		}
		const origin = element.getOrigin?.() ?? { x: 0, y: 0 }, anchor = new Vec2(origin.x, origin.y),
			screen = session.camera.worldToScreen(anchor),
			dpr = window.devicePixelRatio || 1;
		this.editingLabelId = id;
		// screen.x/y are already stage-relative CSS pixels — both canvases
		// sit at .stage's own origin (inset:0), so no extra rect math needed.
		this.textAnchor = anchor;
		this.input.style.left = `${ screen.x / dpr }px`;
		this.input.style.top = `${ screen.y / dpr }px`;
		this.input.value = element.getName?.() ?? String(element.value ?? '');
		this.input.placeholder = 'Edit text…';
		this.input.classList.remove('hidden');
		this.input.focus();
		this.input.select();
	}

	protected preview(anchor: Vec2, text: string): EditPreviewState | null {
		const tool = this.activeTool();
		switch (tool) {
			case 'text':
				return { kind: 'text', anchor, text };
			case 'label':
				return { kind: 'label', anchor, text, rotation: 0 };
			case 'directive-label':
				return { kind: tool, anchor, text, shape: this.cb.getDirectiveLabelShape(), rotation: 0 };
			case 'global-label':
			case 'hier-label':
				return { kind: tool, anchor, text, shape: this.cb.getLabelShape(), rotation: 0 };
			case 'power':
				return { kind: 'text', anchor, text };
			default:
				return null;
		}
	}

	protected boxPreview(text: string): EditPreviewState | null {
		return this.boxBounds ? { kind: 'text-box', ...this.boxBounds, text } : null;
	}

	protected updateTextPreview(): void {
		if (this.textAnchor && !this.editingLabelId) {
			this.cb.getSession()
				?.setEditPreview(this.preview(this.textAnchor, this.input.value));
		}
	}

	protected updateBoxPreview(): void { this.cb.getSession()?.setEditPreview(this.boxPreview(this.boxInput.value)); }

	protected hideText(): void {
		this.input.classList.add('hidden');
		this.input.value = '';
		this.boxInput.classList.add('hidden');
		this.boxInput.value = '';
		this.textAnchor = null;
		this.boxBounds = null;
		this.editingLabelId = null;
		this.cb.getSession()?.setEditPreview(null);
	}

	protected commitText(): void {
		const session = this.cb.getSession(), value = this.input.value.trim();
		if (this.editingLabelId) {
			if (value && session?.renameLabel(this.editingLabelId, value)) {
				this.appState.refreshSchematicText(session);
				this.cb.setStatus('Renamed.');
			}
			this.hideText();
			return;
		}
		const anchor = this.textAnchor;
		if (!session || !anchor || !value) {
			this.hideText();
			return;
		}
		const tool = this.activeTool();
		if (session.documentTypeLoaded === 'board') {
			if (tool === 'text') {
				session.addBoardGraphicText(anchor.x, anchor.y, value, this.cb.getActiveBoardLayer?.() ?? 'F.SilkS');
				this.appState.refreshBoardText(session);
				this.cb.setStatus(`Added text "${ value }".`);
			}
			this.hideText();
			return;
		}
		switch (tool) {
			case 'text':
				session.addGraphicText(anchor.x, anchor.y, value);
				this.cb.setStatus(`Added text "${ value }".`);
				break;
			case 'label':
				session.addLabel(anchor.x, anchor.y, value);
				this.cb.setStatus(`Added label "${ value }".`);
				break;
			case 'directive-label':
				session.addDirectiveLabel(anchor.x, anchor.y, value, this.cb.getDirectiveLabelShape());
				this.cb.setStatus(`Added directive label "${ value }".`);
				break;
			case 'global-label':
				session.addGlobalLabel(anchor.x, anchor.y, value, this.cb.getLabelShape());
				this.cb.setStatus(`Added global label "${ value }".`);
				break;
			case 'hier-label':
				session.addHierLabel(anchor.x, anchor.y, value, this.cb.getLabelShape());
				this.cb.setStatus(`Added hierarchical label "${ value }".`);
				break;
			case 'power':
				session.addPowerRail(anchor.x, anchor.y, value);
				this.cb.setStatus(`Added power rail "${ value }".`);
				break;
		}
		this.appState.refreshSchematicText(session);
		this.hideText();
	}

	protected commitBox(): void {
		const session = this.cb.getSession(), b = this.boxBounds, value = this.boxInput.value.trim();
		if (session && b && value) {
			if (session.documentTypeLoaded === 'board') {
				session.addBoardGraphicTextBox(b.x, b.y, b.x + b.width, b.y + b.height, value, this.cb.getActiveBoardLayer?.() ?? 'F.SilkS');
				this.appState.refreshBoardText(session);
			}
			else {
				session.addGraphicTextBox(b.x, b.y, b.x + b.width, b.y + b.height, value);
				this.appState.refreshSchematicText(session);
			}
			this.cb.setStatus('Added text box.');
		}
		this.hideText();
	}

	protected activeTool(): TextEntryTool {
		return this.cb.getSession()?.documentTypeLoaded === 'board'
			? (this.cb.getBoardTool?.() ?? 'select')
			: this.cb.getTool();
	}

	protected cancelTable(): void {
		this.tableAnchor = null;
		this.tableId = null;
		this.tableModal.classList.add('hidden');
	}

	protected commitTable(): void {
		const session = this.cb.getSession(), anchor = this.tableAnchor;
		if (!session || !anchor) {
			return;
		}
		const rows = Math.max(1, Math.min(30, Number(this.rowsInput.value) || 1)),
			columns = Math.max(1, Math.min(20, Number(this.columnsInput.value) || 1));
		if (this.tableId) {
			session.deleteElements([this.tableId]);
		}
		if (session.addGraphicTable(
			anchor.x, anchor.y, rows, columns, this.dataInput.value.split(/\r?\n/).map(row => row.split('\t')))) {
			this.appState.refreshSchematicText(session);
			this.cb.setStatus('Added table.');
		}
		this.cancelTable();
	}

	protected tableKey(event: KeyboardEvent): void {
		if (event.key !== 'Tab') {
			return;
		}
		event.preventDefault();
		const start = this.dataInput.selectionStart, end = this.dataInput.selectionEnd, value = this.dataInput.value;
		this.dataInput.value = value.slice(0, start) + '\t' + value.slice(end);
		this.dataInput.selectionStart = this.dataInput.selectionEnd = start + 1;
	}

	protected textKey(event: KeyboardEvent): void {
		event.stopPropagation();
		if (event.key === 'Enter') {
			event.preventDefault();
			this.commitText();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			this.hideText();
			return;
		}
		if (event.key !== 'Tab' || this.editingLabelId) {
			return;
		}
		const tool = this.cb.getTool();
		if (tool === 'global-label' || tool === 'hier-label') {
			event.preventDefault();
			const next = LABEL_SHAPES[(LABEL_SHAPES.indexOf(this.cb.getLabelShape()) + 1) % LABEL_SHAPES.length]!;
			this.cb.setLabelShape(next);
		}
		else if (tool === 'directive-label') {
			event.preventDefault();
			const next = DIRECTIVE_LABEL_SHAPES[(DIRECTIVE_LABEL_SHAPES.indexOf(this.cb.getDirectiveLabelShape()) + 1)
			% DIRECTIVE_LABEL_SHAPES.length]!;
			this.cb.setDirectiveLabelShape(next);
		}
		else {
			return;
		}
		this.updateTextPreview();
		this.cb.updateHint();
	}

	protected textBlur(): void {
		if (!this.input.classList.contains('hidden')) {
			if (this.input.value.trim()) {
				this.commitText();
			}
			else {
				this.hideText();
			}
		}
	}

	protected boxKey(event: KeyboardEvent): void {
		event.stopPropagation();
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			this.commitBox();
		}
		else if (event.key === 'Escape') {
			event.preventDefault();
			this.hideText();
		}
	}

	protected boxBlur(): void {
		if (!this.boxInput.classList.contains('hidden')) {
			this.commitBox();
		}
	}
}
