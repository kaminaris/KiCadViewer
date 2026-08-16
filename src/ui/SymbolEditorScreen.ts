import { KicadElement } from '@kicad-io/KicadElement';
import { KicadElementPin } from '@kicad-io/KicadElementPin';
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
	protected readonly inspectorEl: HTMLElement;
	protected readonly propertiesEl: HTMLDivElement;
	protected readonly pinsEl: HTMLDivElement;
	protected initialText = '';
	protected currentFileLabel = 'Symbol library';
	protected currentRoot: KicadElement | null = null;
	protected currentSymbol: KicadElementSymbol | null = null;
	protected selectedPin: KicadElementPin | null = null;

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
		const editorSurface = document.createElement('div');
		editorSurface.className = 'symbol-editor-surface';
		const codePanel = document.createElement('div');
		codePanel.className = 'symbol-editor-code-panel';
		this.textarea = document.createElement('textarea');
		this.textarea.className = 'symbol-editor-textarea';
		this.textarea.spellcheck = false;
		this.textarea.addEventListener('input', () => this.syncDirtyState());
		this.placeholder = document.createElement('div');
		this.placeholder.className = 'symbol-editor-empty';
		this.placeholder.textContent = 'No symbol library file is indexed yet.';
		codePanel.append(this.textarea, this.placeholder);
		this.inspectorEl = document.createElement('aside');
		this.inspectorEl.className = 'symbol-editor-inspector';
		this.propertiesEl = document.createElement('div');
		this.propertiesEl.className = 'symbol-editor-inspector-section';
		this.pinsEl = document.createElement('div');
		this.pinsEl.className = 'symbol-editor-inspector-section';
		this.inspectorEl.append(this.propertiesEl, this.pinsEl);
		editorSurface.append(codePanel, this.inspectorEl);
		form.append(editorSurface);

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
		this.currentRoot = this.parseRootText(sourceText);
		this.currentSymbol = this.currentRoot ? this.findPrimarySymbol(this.currentRoot) : null;
		const symbolName = this.extractSymbolName(sourceText);
		this.currentSymbolName = symbolName;
		this.titleEl.textContent = symbolName;
		this.metaEl.textContent = `${ this.currentFileLabel } • Symbol library source`;
		this.renderFileList(files, file.id);
		this.renderSymbolList(file.symbols, symbolName);
		this.renderSymbolInspector(this.currentSymbol);
		this.syncDirtyState();
	}

	protected parseRootText(sourceText: string): KicadElement | null {
		try {
			return new KicadParser().parse(sourceText) as KicadElement;
		}
		catch {
			return null;
		}
	}

	protected findPrimarySymbol(root: KicadElement | null): KicadElementSymbol | null {
		if (!root) {
			return null;
		}
		return root.findChildrenByClass(KicadElementSymbol)[0] ?? null;
	}

	protected refreshTextFromAst(): void {
		if (!this.currentRoot) {
			return;
		}
		this.textarea.value = this.currentRoot.write();
		this.syncDirtyState();
		if (this.currentSymbol) {
			const name = this.currentSymbol.symbolName || 'Symbol';
			this.currentSymbolName = name;
			this.titleEl.textContent = name;
		}
	}

	protected createEditorField(label: string, value: string, onChange: (nextValue: string) => void): HTMLElement {
		const row = document.createElement('label');
		row.className = 'symbol-editor-field-row';
		const title = document.createElement('span');
		title.className = 'symbol-editor-field-label';
		title.textContent = label;
		const input = document.createElement('input');
		input.type = 'text';
		input.value = value;
		input.addEventListener('change', () => onChange(input.value));
		row.append(title, input);
		return row;
	}

	protected renderSymbolInspector(symbol: KicadElementSymbol | null): void {
		this.propertiesEl.replaceChildren();
		this.pinsEl.replaceChildren();
		if (!symbol) {
			const empty = document.createElement('div');
			empty.className = 'symbol-editor-empty-item';
			empty.textContent = 'No symbol selected';
			this.propertiesEl.append(empty);
			return;
		}

		const metaCard = document.createElement('div');
		metaCard.className = 'symbol-editor-inspector-card';
		const metaTitle = document.createElement('div');
		metaTitle.className = 'symbol-editor-inspector-title';
		metaTitle.textContent = 'Symbol';
		metaCard.append(metaTitle);
		metaCard.append(this.createEditorField('Name', symbol.symbolName ?? '', value => {
			const nextName = value.trim() || 'Symbol';
			symbol.setSymbolName(nextName);
			this.currentSymbolName = nextName;
			this.titleEl.textContent = nextName;
			this.refreshTextFromAst();
		}));
		const descriptionValue = symbol.getPropertyByName('Description')?.propertyValue ?? '';
		metaCard.append(this.createEditorField('Description', descriptionValue, value => {
			symbol.setProperty('Description', value);
			this.refreshTextFromAst();
		}));
		const addPropertyBtn = document.createElement('button');
		addPropertyBtn.type = 'button';
		addPropertyBtn.className = 'symbol-editor-mini-button';
		addPropertyBtn.textContent = 'Add property';
		addPropertyBtn.addEventListener('click', () => {
			const name = `Property_${ symbol.getProperties().length + 1 }`;
			symbol.setProperty(name, '');
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
		});
		metaCard.append(addPropertyBtn);
		this.propertiesEl.append(metaCard);

		const propertyList = document.createElement('div');
		propertyList.className = 'symbol-editor-property-list';
		for (const property of symbol.getProperties()) {
			const row = document.createElement('div');
			row.className = 'symbol-editor-property-row';
			const nameInput = document.createElement('input');
			nameInput.type = 'text';
			nameInput.value = property.propertyName ?? '';
			const valueInput = document.createElement('input');
			valueInput.type = 'text';
			valueInput.value = property.propertyValue ?? '';
			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.className = 'symbol-editor-mini-button';
			removeBtn.textContent = '×';
			removeBtn.title = 'Remove property';
			removeBtn.addEventListener('click', () => {
				const currentName = property.propertyName ?? '';
				if (currentName) {
					symbol.deleteProperty(currentName);
					this.refreshTextFromAst();
					this.renderSymbolInspector(symbol);
				}
			});
			nameInput.addEventListener('change', () => {
				const currentName = property.propertyName ?? '';
				const nextName = nameInput.value.trim();
				if (!nextName) {
					return;
				}
				if (currentName) {
					symbol.deleteProperty(currentName);
				}
				symbol.setProperty(nextName, valueInput.value);
				this.refreshTextFromAst();
				this.renderSymbolInspector(symbol);
			});
			valueInput.addEventListener('change', () => {
				const name = property.propertyName ?? nameInput.value.trim();
				if (!name) {
					return;
				}
				symbol.setProperty(name, valueInput.value);
				this.refreshTextFromAst();
			});
			row.append(nameInput, valueInput, removeBtn);
			propertyList.append(row);
		}
		this.propertiesEl.append(propertyList);

		const pinCard = document.createElement('div');
		pinCard.className = 'symbol-editor-inspector-card';
		const pinTitle = document.createElement('div');
		pinTitle.className = 'symbol-editor-inspector-title';
		pinTitle.textContent = 'Pins';
		const addPinBtn = document.createElement('button');
		addPinBtn.type = 'button';
		addPinBtn.className = 'symbol-editor-mini-button';
		addPinBtn.textContent = 'Add pin';
		addPinBtn.addEventListener('click', () => {
			const pin = new KicadElementPin();
			const existingPins = this.collectPins(symbol);
			const nextNumber = `${ existingPins.length + 1 }`;
			pin.setPin('PIN', nextNumber);
			pin.setOrigin(0, 0, 0);
			pin.setLength(100);
			pin.setType('passive', 'line');
			symbol.addChild(pin);
			this.selectedPin = pin;
			this.refreshTextFromAst();
			this.renderSymbolInspector(symbol);
		});
		pinCard.append(pinTitle, addPinBtn);
		const pins = this.collectPins(symbol);
		if (!pins.length) {
			const empty = document.createElement('div');
			empty.className = 'symbol-editor-empty-item';
			empty.textContent = 'No pins defined';
			pinCard.append(empty);
			this.pinsEl.append(pinCard);
			return;
		}
		const pinList = document.createElement('div');
		pinList.className = 'symbol-editor-pin-list';
		for (const pin of pins) {
			const pinItem = document.createElement('button');
			pinItem.type = 'button';
			pinItem.className = 'symbol-editor-pin-item';
			if (this.selectedPin === pin) {
				pinItem.classList.add('is-selected');
			}
			const pinInfo = pin.getPin();
			pinItem.textContent = `${ pinInfo.number || '?' } ${ pinInfo.name ? `- ${ pinInfo.name }` : '' }`;
			pinItem.title = pinInfo.name || pinInfo.number || 'Pin';
			pinItem.addEventListener('click', () => {
				this.selectedPin = pin;
				this.renderSymbolInspector(symbol);
			});
			pinList.append(pinItem);
		}
		pinCard.append(pinList);
		this.pinsEl.append(pinCard);
		if (!this.selectedPin || !pins.includes(this.selectedPin)) {
			this.selectedPin = pins[0] ?? null;
		}
		if (this.selectedPin) {
			const editor = document.createElement('div');
			editor.className = 'symbol-editor-pin-editor';
			const pinInfo = this.selectedPin.getPin();
			const origin = this.selectedPin.getOrigin();
			const typeInfo = this.selectedPin.getType();
			editor.append(this.createEditorField('Pin number', pinInfo.number, value => {
				this.selectedPin!.setPin(this.selectedPin!.getPin().name, value || '1');
				this.refreshTextFromAst();
				this.renderSymbolInspector(symbol);
			}));
			editor.append(this.createEditorField('Pin name', pinInfo.name, value => {
				this.selectedPin!.setPin(value, this.selectedPin!.getPin().number || '1');
				this.refreshTextFromAst();
				this.renderSymbolInspector(symbol);
			}));
			editor.append(this.createEditorField('X', `${ origin.x }`, value => {
				const next = Number.parseFloat(value) || 0;
				this.selectedPin!.setOrigin(next, origin.y, origin.rotation);
				this.refreshTextFromAst();
			}));
			editor.append(this.createEditorField('Y', `${ origin.y }`, value => {
				const next = Number.parseFloat(value) || 0;
				this.selectedPin!.setOrigin(origin.x, next, origin.rotation);
				this.refreshTextFromAst();
			}));
			editor.append(this.createEditorField('Length', `${ this.selectedPin.getLength() }`, value => {
				this.selectedPin!.setLength(Number.parseFloat(value) || 0);
				this.refreshTextFromAst();
			}));
			const typeRow = document.createElement('label');
			typeRow.className = 'symbol-editor-field-row';
			const typeLabel = document.createElement('span');
			typeLabel.className = 'symbol-editor-field-label';
			typeLabel.textContent = 'Type';
			const typeSelect = document.createElement('select');
			for (const value of ['input', 'output', 'bidirectional', 'tri_state', 'passive', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect', 'free', 'unspecified']) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = value;
				if (value === typeInfo.electricalType) {
					option.selected = true;
				}
				typeSelect.append(option);
			}
			typeSelect.addEventListener('change', () => {
				this.selectedPin!.setType(typeSelect.value as any, typeInfo.shape);
				this.refreshTextFromAst();
			});
			typeRow.append(typeLabel, typeSelect);
			editor.append(typeRow);
			const shapeRow = document.createElement('label');
			shapeRow.className = 'symbol-editor-field-row';
			const shapeLabel = document.createElement('span');
			shapeLabel.className = 'symbol-editor-field-label';
			shapeLabel.textContent = 'Shape';
			const shapeSelect = document.createElement('select');
			for (const value of ['line', 'inverted', 'clock', 'inverted_clock', 'input_low', 'clock_low', 'output_low', 'edge_clock_high', 'non_logic']) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = value;
				if (value === typeInfo.shape) {
					option.selected = true;
				}
				shapeSelect.append(option);
			}
			shapeSelect.addEventListener('change', () => {
				this.selectedPin!.setType(typeInfo.electricalType, shapeSelect.value as any);
				this.refreshTextFromAst();
			});
			shapeRow.append(shapeLabel, shapeSelect);
			editor.append(shapeRow);
			const hideRow = document.createElement('label');
			hideRow.className = 'symbol-editor-field-row';
			const hideLabel = document.createElement('span');
			hideLabel.className = 'symbol-editor-field-label';
			hideLabel.textContent = 'Hidden';
			const hideToggle = document.createElement('input');
			hideToggle.type = 'checkbox';
			hideToggle.checked = this.selectedPin.isHidden();
			hideToggle.addEventListener('change', () => {
				this.selectedPin!.setHidden(hideToggle.checked);
				this.refreshTextFromAst();
			});
			hideRow.append(hideLabel, hideToggle);
			editor.append(hideRow);
			this.pinsEl.append(editor);
		}
	}

	protected collectPins(symbol: KicadElementSymbol): KicadElementPin[] {
		const pins: KicadElementPin[] = [];
		const seen = new Set<string>();
		const walk = (node: KicadElementSymbol) => {
			for (const pin of node.findChildrenByClass(KicadElementPin)) {
				const key = pin.getUuid?.() ?? `${ pin.getPin().number }-${ pin.getPin().name }-${ pin.getOrigin().x }-${ pin.getOrigin().y }`;
				if (!seen.has(key)) {
					seen.add(key);
					pins.push(pin);
				}
			}
			for (const unit of node.getLayers()) {
				walk(unit);
			}
		};
		walk(symbol);
		return pins;
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
		this.currentRoot = this.parseRootText(this.initialText);
		this.currentSymbol = this.currentRoot ? this.findPrimarySymbol(this.currentRoot) : null;
		this.selectedPin = null;
		this.textarea.value = this.initialText;
		this.renderSymbolInspector(this.currentSymbol);
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
