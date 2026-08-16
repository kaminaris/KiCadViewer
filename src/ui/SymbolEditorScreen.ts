import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';
import { KicadParser } from '@kicad-io/KicadParser';
import type { SymbolLibraryCache } from '../io/SymbolLibraryCache';

export interface SymbolEditorScreenCallbacks {
	saveFile(fileId: string, text: string): Promise<void>;

	onBack?: () => void;
}

export class SymbolEditorScreen {
	protected fileId: string | null = null;
	protected currentSymbolName: string | null = null;
	protected readonly cache: SymbolLibraryCache;
	protected readonly callbacks: SymbolEditorScreenCallbacks;
	protected readonly backBtn: HTMLButtonElement;
	protected readonly titleEl: HTMLHeadingElement;
	protected readonly metaEl: HTMLDivElement;
	protected readonly statusEl: HTMLDivElement;
	protected readonly fileListEl: HTMLDivElement;
	protected readonly symbolListEl: HTMLDivElement;
	protected readonly textarea: HTMLTextAreaElement;
	protected readonly saveBtn: HTMLButtonElement;
	protected readonly revertBtn: HTMLButtonElement;
	protected readonly placeholder: HTMLDivElement;
	protected initialText = '';
	protected currentFileLabel = 'Symbol library';

	constructor(root: HTMLElement, cache: SymbolLibraryCache, callbacks: SymbolEditorScreenCallbacks) {
		this.cache = cache;
		this.callbacks = callbacks;

		const shell = document.createElement('div');
		shell.className = 'symbol-editor-shell';

		const header = document.createElement('header');
		header.className = 'symbol-editor-header';
		const titleRow = document.createElement('div');
		titleRow.className = 'symbol-editor-title-row';
		this.backBtn = document.createElement('button');
		this.backBtn.type = 'button';
		this.backBtn.className = 'symbol-editor-back';
		this.backBtn.textContent = '← Back';
		this.backBtn.addEventListener('click', () => this.callbacks.onBack?.());
		const title = document.createElement('h1');
		title.className = 'symbol-editor-title';
		title.textContent = 'Symbol Editor';
		this.titleEl = title;
		const status = document.createElement('div');
		status.className = 'symbol-editor-status';
		this.statusEl = status;
		titleRow.append(this.backBtn, title, status);

		const meta = document.createElement('div');
		meta.className = 'symbol-editor-meta';
		this.metaEl = meta;
		header.append(titleRow, meta);

		const actions = document.createElement('div');
		actions.className = 'symbol-editor-actions';
		this.saveBtn = document.createElement('button');
		this.saveBtn.type = 'button';
		this.saveBtn.textContent = 'Save';
		this.saveBtn.className = 'symbol-editor-save';
		this.saveBtn.addEventListener('click', () => { void this.save(); });
		this.revertBtn = document.createElement('button');
		this.revertBtn.type = 'button';
		this.revertBtn.textContent = 'Revert';
		this.revertBtn.className = 'symbol-editor-revert';
		this.revertBtn.addEventListener('click', () => this.revert());
		actions.append(this.revertBtn, this.saveBtn);

		const layout = document.createElement('div');
		layout.className = 'symbol-editor-layout';
		const sidebar = document.createElement('aside');
		sidebar.className = 'symbol-editor-sidebar';
		const fileSection = document.createElement('section');
		fileSection.className = 'symbol-editor-section';
		const fileSectionTitle = document.createElement('div');
		fileSectionTitle.className = 'symbol-editor-section-title';
		fileSectionTitle.textContent = 'Libraries';
		this.fileListEl = document.createElement('div');
		this.fileListEl.className = 'symbol-editor-list';
		fileSection.append(fileSectionTitle, this.fileListEl);
		const symbolSection = document.createElement('section');
		symbolSection.className = 'symbol-editor-section';
		const symbolSectionTitle = document.createElement('div');
		symbolSectionTitle.className = 'symbol-editor-section-title';
		symbolSectionTitle.textContent = 'Symbols';
		this.symbolListEl = document.createElement('div');
		this.symbolListEl.className = 'symbol-editor-list';
		symbolSection.append(symbolSectionTitle, this.symbolListEl);
		sidebar.append(fileSection, symbolSection);

		const form = document.createElement('div');
		form.className = 'symbol-editor-form';
		this.textarea = document.createElement('textarea');
		this.textarea.className = 'symbol-editor-textarea';
		this.textarea.spellcheck = false;
		this.textarea.addEventListener('input', () => this.syncDirtyState());
		this.placeholder = document.createElement('div');
		this.placeholder.className = 'symbol-editor-empty';
		this.placeholder.textContent = 'No symbol library file is indexed yet.';
		form.append(this.textarea, this.placeholder);

		layout.append(sidebar, form);
		shell.append(header, actions, layout);
		root.replaceChildren(shell);
		this.setEmptyState();
	}

	get isDirty(): boolean {
		return !!this.fileId && this.textarea.value !== this.initialText;
	}

	async open(fileId: string | null): Promise<void> {
		const files = (await this.cache.getFiles()).sort(
			(a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name));
		if (!files.length) {
			this.fileId = null;
			this.setEmptyState();
			return;
		}
		const file = fileId ? files.find(item => item.id === fileId) ?? files[0] : files[0];
		this.renderFileList(files, file.id);
		await this.loadFile(file.id);
	}

	async loadFile(fileId: string): Promise<void> {
		const files = (await this.cache.getFiles()).sort(
			(a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name));
		const file = files.find(item => item.id === fileId) ?? files[0];
		if (!file) {
			this.fileId = null;
			this.setEmptyState();
			return;
		}
		this.fileId = file.id;
		this.currentFileLabel = file.relativePath || file.name;
		const sourceText = await this.cache.readCachedFile(file.id);
		this.initialText = sourceText;
		this.textarea.value = sourceText;
		this.textarea.disabled = false;
		this.placeholder.hidden = true;
		const symbolName = this.extractSymbolName(sourceText);
		this.currentSymbolName = symbolName;
		this.titleEl.textContent = symbolName;
		this.metaEl.textContent = `${ this.currentFileLabel } • Symbol library source`;
		this.renderFileList(files, file.id);
		this.renderSymbolList(file.symbols, symbolName);
		this.syncDirtyState();
	}

	async save(): Promise<boolean> {
		if (!this.fileId) {
			return false;
		}
		const text = this.textarea.value;
		try {
			await this.callbacks.saveFile(this.fileId, text);
			this.initialText = text;
			this.syncDirtyState();
			this.statusEl.textContent = 'Saved';
			return true;
		}
		catch (error) {
			this.statusEl.textContent = error instanceof Error ? error.message : String(error);
			this.statusEl.classList.add('is-error');
			return false;
		}
	}

	revert(): void {
		if (!this.fileId) {
			return;
		}
		this.textarea.value = this.initialText;
		this.syncDirtyState();
	}

	protected renderFileList(
		files: Array<{ id: string; relativePath: string; name: string }>, selectedId: string): void {
		this.fileListEl.replaceChildren();
		for (const file of files) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'symbol-editor-list-item';
			if (file.id === selectedId) {
				row.classList.add('is-selected');
			}
			row.textContent = file.relativePath || file.name;
			row.title = file.relativePath || file.name;
			row.addEventListener('click', () => { void this.loadFile(file.id); });
			this.fileListEl.append(row);
		}
	}

	protected renderSymbolList(
		symbols: Array<{ name: string; description: string }>, selectedName: string | null): void {
		this.symbolListEl.replaceChildren();
		if (!symbols.length) {
			const empty = document.createElement('div');
			empty.className = 'symbol-editor-empty-item';
			empty.textContent = 'No symbols parsed';
			this.symbolListEl.append(empty);
			return;
		}
		for (const symbol of symbols) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'symbol-editor-list-item';
			if (selectedName && symbol.name === selectedName) {
				row.classList.add('is-selected');
			}
			row.textContent = symbol.name;
			row.title = symbol.description || symbol.name;
			row.addEventListener('click', () => {
				this.currentSymbolName = symbol.name;
				this.titleEl.textContent = symbol.name;
				this.metaEl.textContent = `${ this.currentFileLabel } • ${ symbol.name }`;
				this.renderSymbolList(symbols, symbol.name);
			});
			this.symbolListEl.append(row);
		}
	}

	protected setEmptyState(): void {
		this.fileId = null;
		this.currentSymbolName = null;
		this.initialText = '';
		this.textarea.value = '';
		this.textarea.disabled = true;
		this.placeholder.hidden = false;
		this.fileListEl.replaceChildren();
		this.symbolListEl.replaceChildren();
		this.titleEl.textContent = 'Symbol Editor';
		this.metaEl.textContent = 'No symbol library loaded';
		this.statusEl.textContent = 'Idle';
		this.statusEl.classList.remove('is-dirty', 'is-error');
		this.saveBtn.disabled = true;
		this.revertBtn.disabled = true;
	}

	protected syncDirtyState(): void {
		const dirty = this.isDirty;
		this.saveBtn.disabled = !dirty || !this.fileId;
		this.revertBtn.disabled = !dirty || !this.fileId;
		this.statusEl.classList.toggle('is-dirty', dirty);
		this.statusEl.classList.remove('is-error');
		this.statusEl.textContent = dirty ? 'Unsaved changes' : 'Saved';
	}

	protected extractSymbolName(sourceText: string): string {
		try {
			const root = new KicadParser().parse(sourceText);
			const symbol = root?.children.find(
				child => child instanceof KicadElementSymbol) as KicadElementSymbol | undefined;
			if (symbol?.symbolName) {
				return symbol.symbolName;
			}
		}
		catch {
			// Fall back to the raw-text regex below when parsing fails.
		}
		const match = sourceText.match(/\(symbol\s+"([^"]+)"/);
		return match?.[1] ?? 'Symbol';
	}
}
