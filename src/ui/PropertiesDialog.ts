import { makeDraggableResizable } from './DraggableResizable';

/** Owns the double-click properties modal surface. Dialog renderers can use
 *  `body` and `setTitle()` while the editor delegates open/close lifecycle. */
export interface KdGridColumn {
	key: string;
	label: string;
	type: 'text' | 'checkbox' | 'select';
	options?: { value: string; label: string }[];
	readOnly?: (row: Record<string, unknown>) => boolean;
	/** For a 'text' column: an optional per-ROW trailing browse button (the
	 *  Fields grid's Footprint row gets one, every other row in the same
	 *  Value column doesn't) — return a click handler to show the button
	 *  for this row, or null/undefined to render a plain input like usual. */
	button?: (row: Record<string, unknown>, rowIndex: number) => (() => void) | null | undefined;
}

export interface KdGridHandlers {
	onCellChange: (rowIndex: number, key: string, value: string | boolean) => void;
	onAddRow?: () => void;
	onRemoveRow?: (rowIndex: number) => void;
	canRemoveRow?: (rowIndex: number) => boolean;
}

export class PropertiesDialog {
	protected readonly modal = document.getElementById('properties-modal') as HTMLDivElement;
	readonly body = document.getElementById('properties-modal-body') as HTMLDivElement;
	protected readonly title = document.getElementById('properties-modal-title') as HTMLHeadingElement;

	constructor() {
		makeDraggableResizable(this.modal, this.title, { minWidth: 420, minHeight: 240 });
	}

	get isOpen(): boolean { return !this.modal.classList.contains('hidden'); }

	setTitle(value: string): void { this.title.textContent = value; }

	clear(): void { this.body.replaceChildren(); }

	show(): void { this.modal.classList.remove('hidden'); }

	close(): void {
		this.modal.classList.add('hidden');
		this.clear();
	}

	get element(): HTMLDivElement { return this.modal; }

	section(container: HTMLElement, title: string): HTMLElement {
		const section = document.createElement('section');
		section.className = 'property-section kd-section';
		const heading = document.createElement('div');
		heading.className = 'property-section-title';
		heading.textContent = title;
		section.appendChild(heading);
		container.appendChild(section);
		return section;
	}

	columns(container: HTMLElement): [HTMLElement, HTMLElement] {
		const wrap = document.createElement('div');
		wrap.className = 'kd-columns';
		const left = document.createElement('div'), right = document.createElement('div');
		wrap.append(left, right);
		container.appendChild(wrap);
		return [left, right];
	}

	row(container: HTMLElement): HTMLElement {
		const row = document.createElement('div');
		row.className = 'kd-row';
		container.appendChild(row);
		return row;
	}

	label(row: HTMLElement, text: string): void {
		const label = document.createElement('span');
		label.className = 'kd-label';
		label.textContent = text;
		row.appendChild(label);
	}

	unit(row: HTMLElement, text: string): void {
		const unit = document.createElement('span');
		unit.className = 'kd-unit';
		unit.textContent = text;
		row.appendChild(unit);
	}

	textInput(row: HTMLElement, value: string, save: (value: string) => void, numeric = false): HTMLInputElement {
		const input = document.createElement('input');
		input.className = `kd-input${ numeric ? ' kd-input-num' : '' }`;
		input.value = value;
		const commit = () => {
			if (input.value !== value) {
				save(input.value);
			}
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				commit();
				input.blur();
			}
		});
		row.appendChild(input);
		return input;
	}

	select(
		row: HTMLElement, value: string, options: { value: string; label: string }[],
		save: (value: string) => void
	): HTMLSelectElement {
		const select = document.createElement('select');
		select.className = 'kd-input';
		for (const option of options) {
			const item = document.createElement('option');
			item.value = option.value;
			item.textContent = option.label;
			select.appendChild(item);
		}
		select.value = options.some(option => option.value === value) ? value : (options[0]?.value ?? '');
		select.addEventListener('change', () => save(select.value));
		row.appendChild(select);
		return select;
	}

	swatch(row: HTMLElement, value: string | null | undefined, save: (hex: string) => void): void {
		const input = document.createElement('input');
		input.type = 'color';
		input.className = 'kd-swatch';
		input.value = this.colorToHex(value) ?? '#808080';
		input.addEventListener('change', () => save(input.value));
		row.appendChild(input);
	}

	checkRow(container: HTMLElement, text: string, checked: boolean, save: (value: boolean) => void): HTMLInputElement {
		const row = document.createElement('label');
		row.className = 'kd-check-row';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.addEventListener('change', () => save(input.checked));
		const span = document.createElement('span');
		span.textContent = text;
		row.append(input, span);
		container.appendChild(row);
		return input;
	}

	radioRow(container: HTMLElement, groupName: string, text: string, checked: boolean, save: () => void): void {
		const row = document.createElement('label');
		row.className = 'kd-radio-row';
		const input = document.createElement('input');
		input.type = 'radio';
		input.name = groupName;
		input.checked = checked;
		input.addEventListener('change', () => {
			if (input.checked) {
				save();
			}
		});
		const span = document.createElement('span');
		span.textContent = text;
		row.append(input, span);
		container.appendChild(row);
	}

	textArea(container: HTMLElement, value: string, save: (value: string) => void, rows = 3): HTMLTextAreaElement {
		const area = document.createElement('textarea');
		area.className = 'kd-input';
		area.rows = rows;
		area.style.width = '100%';
		area.style.boxSizing = 'border-box';
		area.style.resize = 'vertical';
		area.value = value;
		area.addEventListener('blur', () => {
			if (area.value !== value) {
				save(area.value);
			}
		});
		container.appendChild(area);
		return area;
	}

	inlineCheck(row: HTMLElement, text: string, checked: boolean, save: (value: boolean) => void): void {
		const wrap = document.createElement('label');
		wrap.className = 'kd-check-row';
		wrap.style.display = 'inline-flex';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.addEventListener('change', () => save(input.checked));
		const span = document.createElement('span');
		span.textContent = text;
		wrap.append(input, span);
		row.appendChild(wrap);
	}

	help(container: HTMLElement, text: string): void {
		const help = document.createElement('div');
		help.className = 'kd-help';
		help.textContent = text;
		container.appendChild(help);
	}

	buttonRow(container: HTMLElement): HTMLElement {
		const row = document.createElement('div');
		row.className = 'kd-btn-row';
		container.appendChild(row);
		return row;
	}

	button(
		container: HTMLElement, text: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'kd-btn';
		button.textContent = text;
		button.addEventListener('click', onClick);
		container.appendChild(button);
		return button;
	}

	grid(
		container: HTMLElement, columns: KdGridColumn[], rows: Record<string, unknown>[],
		handlers: KdGridHandlers
	): void {
		const wrap = document.createElement('div');
		wrap.className = 'kd-grid-wrap';
		const table = document.createElement('table');
		table.className = 'kd-grid';
		const head = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const column of columns) {
			const cell = document.createElement('th');
			cell.textContent = column.label;
			headRow.appendChild(cell);
		}
		if (handlers.onRemoveRow) {
			headRow.appendChild(document.createElement('th'));
		}
		head.appendChild(headRow);
		table.appendChild(head);
		const body = document.createElement('tbody');
		rows.forEach((row, rowIndex) => {
			const tableRow = document.createElement('tr');
			for (const column of columns) {
				const cell = document.createElement('td');
				const value = row[column.key];
				if (column.type === 'checkbox') {
					cell.className = 'kd-grid-check';
					const input = document.createElement('input');
					input.type = 'checkbox';
					input.checked = !!value;
					input.addEventListener('change', () => handlers.onCellChange(rowIndex, column.key, input.checked));
					cell.appendChild(input);
				}
				else if (column.type === 'select' && column.options) {
					const select = document.createElement('select');
					select.className = 'kd-input';
					for (const option of column.options) {
						const item = document.createElement('option');
						item.value = option.value;
						item.textContent = option.label;
						select.appendChild(item);
					}
					select.value = column.options.some(option => option.value === value) ? String(value) :
						(column.options[0]?.value ?? '');
					select.addEventListener('change', () => handlers.onCellChange(rowIndex, column.key, select.value));
					cell.appendChild(select);
				}
				else {
					const input = document.createElement('input');
					input.className = 'kd-input';
					input.value = String(value ?? '');
					if (column.readOnly?.(row)) {
						input.disabled = true;
					}
					const commit = () => handlers.onCellChange(rowIndex, column.key, input.value);
					input.addEventListener('change', commit);
					input.addEventListener('keydown', event => {
						if (event.key === 'Enter') {
							commit();
							input.blur();
						}
					});
					cell.appendChild(input);
					const onButtonClick = column.button?.(row, rowIndex);
					if (onButtonClick) {
						cell.classList.add('kd-grid-text-button');
						const browse = document.createElement('button');
						browse.type = 'button';
						browse.className = 'kd-grid-browse-btn';
						browse.textContent = '…';
						browse.title = 'Browse…';
						browse.addEventListener('click', onButtonClick);
						cell.appendChild(browse);
					}
				}
				tableRow.appendChild(cell);
			}
			if (handlers.onRemoveRow) {
				const cell = document.createElement('td');
				cell.className = 'kd-grid-check';
				if (!handlers.canRemoveRow || handlers.canRemoveRow(rowIndex)) {
					this.buttonLikeCell(
						cell, '✕', () => handlers.onRemoveRow!(rowIndex));
				}
				tableRow.appendChild(cell);
			}
			body.appendChild(tableRow);
		});
		table.appendChild(body);
		wrap.appendChild(table);
		container.appendChild(wrap);
		if (handlers.onAddRow) {
			this.button(this.buttonRow(container), '+ Add Field', handlers.onAddRow);
		}
	}

	protected buttonLikeCell(cell: HTMLElement, text: string, onClick: () => void): void {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'kd-grid-row-del';
		button.textContent = text;
		button.addEventListener('click', onClick);
		cell.appendChild(button);
	}

	protected colorToHex(value: string | null | undefined): string | null {
		if (!value) {
			return null;
		}
		const match = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		if (match) {
			return `#${ [match[1], match[2], match[3]].map(
				channel => Number(channel).toString(16).padStart(2, '0')).join('') }`;
		}
		return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
	}
}
