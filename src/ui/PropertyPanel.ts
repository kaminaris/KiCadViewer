/** Shared DOM primitives for the edit-mode property sidebar. Element-specific
 *  renderers remain in main.ts while the panel owns row construction and the
 *  sidebar target. */
export class PropertyPanel {
	constructor(protected readonly target: HTMLElement, protected readonly undoTarget: HTMLElement) {}

	section(title: string): HTMLElement {
		const section = document.createElement('section');
		section.className = 'property-section';
		const heading = document.createElement('div');
		heading.className = 'property-section-title';
		heading.textContent = title;
		section.appendChild(heading);
		this.target.appendChild(section);
		return section;
	}

	row(
		section: HTMLElement, label: string, value: string, editable = false, save?: (value: string) => void,
		onBrowse?: () => void
	): void {
		const row = document.createElement('div');
		row.className = 'property-row';
		const name = document.createElement('div');
		name.className = 'property-label';
		name.textContent = label;
		const cell = document.createElement('div');
		cell.className = 'property-value';
		if (editable) {
			const input = document.createElement('input');
			input.className = 'property-input';
			input.value = value;
			const commit = () => {
				if (input.value !== value) {
					value = input.value;
					save?.(value);
				}
			};
			input.addEventListener('change', commit);
			input.addEventListener('keydown', event => {
				if (event.key === 'Enter') {
					commit();
					input.blur();
				}
			});
			cell.appendChild(input);
			if (onBrowse) {
				cell.classList.add('property-value-browsable');
				const browse = document.createElement('button');
				browse.type = 'button';
				browse.className = 'property-browse-btn';
				browse.textContent = '…';
				browse.title = 'Browse…';
				browse.addEventListener('click', () => onBrowse());
				cell.appendChild(browse);
			}
		}
		else {
			cell.textContent = value;
		}
		row.append(name, cell);
		section.appendChild(row);
	}

	select(
		section: HTMLElement, label: string, value: string, options: { value: string; label: string }[],
		save: (value: string) => void
	): void {
		const row = document.createElement('div');
		row.className = 'property-row';
		const name = document.createElement('div');
		name.className = 'property-label';
		name.textContent = label;
		const cell = document.createElement('div');
		cell.className = 'property-value';
		const select = document.createElement('select');
		select.className = 'property-input';
		for (const option of options) {
			const item = document.createElement('option');
			item.value = option.value;
			item.textContent = option.label;
			select.appendChild(item);
		}
		select.value = options.some(option => option.value === value) ? value : (options[0]?.value ?? '');
		select.addEventListener('change', () => save(select.value));
		cell.appendChild(select);
		row.append(name, cell);
		section.appendChild(row);
	}

	orientation(
		section: HTMLElement, label: string, value: string, options: string[], save: (value: string) => void): void {
		this.select(section, label, value, options.map(option => ({ value: option, label: `${ option }°` })), save);
	}

	checkbox(section: HTMLElement, label: string, checked: boolean, save: (value: boolean) => void): void {
		const row = document.createElement('div');
		row.className = 'property-row';
		const name = document.createElement('div');
		name.className = 'property-label';
		name.textContent = label;
		const cell = document.createElement('div');
		cell.className = 'property-value';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.className = 'property-check';
		input.checked = checked;
		input.addEventListener('change', () => save(input.checked));
		cell.appendChild(input);
		row.append(name, cell);
		section.appendChild(row);
	}

	color(section: HTMLElement, label: string, value: string | null | undefined, save: (value: string) => void): void {
		const row = document.createElement('div');
		row.className = 'property-row';
		const name = document.createElement('div');
		name.className = 'property-label';
		name.textContent = label;
		const cell = document.createElement('div');
		cell.className = 'property-value';
		const input = document.createElement('input');
		input.type = 'color';
		input.className = 'property-input';
		input.value = this.colorToHex(value) ?? '#808080';
		input.addEventListener('change', () => save(input.value));
		cell.appendChild(input);
		row.append(name, cell);
		section.appendChild(row);
	}

	clear(): void { this.target.replaceChildren(); }

	refreshUndoStack(session: {
		getUndoStackDebug(): { undo: { label: string; bytes: number }[]; undoDepth: number; redoDepth: number }
	}): void {
		const history = session.getUndoStackDebug();
		this.undoTarget.innerHTML = history.undo.length || history.redoDepth
			? `<div class="history-summary">Undo: ${ history.undoDepth } · Redo: ${ history.redoDepth }</div>`
			+ history.undo.slice()
				.reverse()
				.map((entry, index) => `<div class="history-row"><span>${ index === 0 ? '↶' :
					'·' }</span> ${ entry.label }<small>${ entry.bytes } B</small></div>`)
				.join('')
			+ (history.redoDepth ? `<div class="history-redo">Redo entries: ${ history.redoDepth }</div>` : '')
			: '<div class="history-empty">No undo snapshots</div>';
	}

	refreshSidebar(
		session: {
			getUndoStackDebug(): { undo: { label: string; bytes: number }[]; undoDepth: number; redoDepth: number }
		},
		renderSelection: () => void
	): void {
		renderSelection();
		this.refreshUndoStack(session);
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
