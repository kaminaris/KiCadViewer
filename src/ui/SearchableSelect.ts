import { el }                            from './Dom';
import { scoreAndSort, type ScoreField } from './search/TextScore';

export interface SearchableSelectOption {
	value: string;
	label: string;
	/** Optional secondary line shown under the label and included in search
	 *  (e.g. a library nickname, a footprint's description). */
	description?: string;
}

export interface SearchableSelectConfig {
	options: readonly SearchableSelectOption[];
	value?: string | null;
	placeholder?: string;
	/** Label for an explicit "no value" row, shown first, always exempt from
	 *  filtering — omit to require picking a real option. */
	emptyLabel?: string;
}

/** Select-with-search: a trigger button + popup list, same trigger/popup
 *  shell shape as ProjectSetupController's existing `stackupColorCell()`
 *  combo (this is the generalized, reusable version of that one-off), with
 *  the popup's filtering running through the SAME eeschema-parity scorer
 *  `SymbolChooser`/`FootprintChooser` use — one search implementation for
 *  all three instead of a fourth reimplementation. Not virtualized (unlike
 *  the choosers' list) — for the hundreds-of-net-classes/layers scale this
 *  targets, a plain filtered DOM list is simpler and fast enough; reach for
 *  `LibraryChooser` instead for anything approaching the choosers'
 *  thousands-of-symbols scale. */
export class SearchableSelect {
	readonly element: HTMLElement;
	protected readonly trigger: HTMLButtonElement;
	protected readonly triggerLabel: HTMLSpanElement;
	protected readonly popup: HTMLElement;
	protected readonly searchInput: HTMLInputElement;
	protected readonly listEl: HTMLElement;
	protected options: readonly SearchableSelectOption[];
	protected currentValue: string | null;
	protected highlightIndex = -1;
	protected filtered: SearchableSelectOption[] = [];
	protected readonly onDocClick = (event: MouseEvent) => {
		if (!this.element.contains(event.target as Node)) {
			this.close();
		}
	};

	constructor(protected config: SearchableSelectConfig, protected readonly onChange: (value: string | null) => void) {
		this.options = config.options;
		this.currentValue = config.value ?? null;

		this.triggerLabel = el('span', { class: 'kd-select-label' });
		this.trigger = el('button', { type: 'button', class: 'kd-select-trigger' }, [
			this.triggerLabel,
			el('span', { class: 'kd-select-caret', textContent: '▾' })
		]);
		this.searchInput = el('input', { type: 'search', class: 'kd-select-search', placeholder: 'Search…' });
		this.listEl = el('div', { class: 'kd-select-list', role: 'listbox' });
		this.popup = el('div', { class: 'kd-select-popup hidden' }, [this.searchInput, this.listEl]);
		this.element = el('div', { class: 'kd-select' }, [this.trigger, this.popup]);

		this.trigger.addEventListener('click', () => { this.isOpen ? this.close() : this.open(); });
		this.searchInput.addEventListener('input', () => this.renderList());
		this.searchInput.addEventListener('keydown', event => this.onSearchKeydown(event));

		this.updateTrigger();
	}

	get isOpen(): boolean { return !this.popup.classList.contains('hidden'); }

	get value(): string | null { return this.currentValue; }

	setOptions(options: readonly SearchableSelectOption[]): void {
		this.options = options;
		this.updateTrigger();
		if (this.isOpen) {
			this.renderList();
		}
	}

	setValue(value: string | null): void {
		this.currentValue = value;
		this.updateTrigger();
	}

	open(): void {
		if (this.isOpen) {
			return;
		}
		this.popup.classList.remove('hidden');
		this.searchInput.value = '';
		this.renderList();
		document.addEventListener('mousedown', this.onDocClick, true);
		this.searchInput.focus();
	}

	close(): void {
		if (!this.isOpen) {
			return;
		}
		this.popup.classList.add('hidden');
		document.removeEventListener('mousedown', this.onDocClick, true);
	}

	protected updateTrigger(): void {
		const selected = this.options.find(option => option.value === this.currentValue);
		this.triggerLabel.textContent = selected?.label ?? this.config.emptyLabel ?? this.config.placeholder
			?? 'Select…';
		this.triggerLabel.classList.toggle('kd-select-placeholder', !selected);
	}

	protected scoreFields(option: SearchableSelectOption): ScoreField[] {
		return [
			{ text: option.label, weight: 8, isName: true },
			{ text: option.description, weight: 2, isName: false }
		];
	}

	protected renderList(): void {
		const query = this.searchInput.value;
		this.filtered = scoreAndSort(
			query, [...this.options], option => this.scoreFields(option), option => option.label);
		this.listEl.replaceChildren();
		if (this.config.emptyLabel && !query) {
			this.listEl.appendChild(this.buildRow({ value: '', label: this.config.emptyLabel }, -1));
		}
		if (!this.filtered.length) {
			this.listEl.appendChild(el('div', { class: 'kd-select-empty', textContent: 'No matches' }));
		}
		this.filtered.forEach((option, index) => this.listEl.appendChild(this.buildRow(option, index)));
		this.highlightIndex = -1;
	}

	protected buildRow(option: SearchableSelectOption, index: number): HTMLElement {
		const isEmptyRow = index === -1;
		const row = el('button', {
			type: 'button',
			class: `kd-select-option${ option.value === this.currentValue ? ' is-selected' : '' }`,
			role: 'option'
		}, [
			el('span', { class: 'kd-select-option-label', textContent: option.label }),
			option.description ? el('span', { class: 'kd-select-option-desc', textContent: option.description }) : null
		]);
		row.addEventListener('click', () => this.commit(isEmptyRow ? null : option.value));
		return row;
	}

	protected commit(value: string | null): void {
		this.currentValue = value;
		this.updateTrigger();
		this.close();
		this.onChange(value);
	}

	protected onSearchKeydown(event: KeyboardEvent): void {
		const rows = [...this.listEl.querySelectorAll<HTMLButtonElement>('.kd-select-option')];
		if (event.key === 'Escape') {
			event.preventDefault();
			this.close();
			this.trigger.focus();
			return;
		}
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!rows.length) {
				return;
			}
			this.highlightIndex = event.key === 'ArrowDown'
				? Math.min(this.highlightIndex + 1, rows.length - 1)
				: Math.max(this.highlightIndex - 1, 0);
			rows.forEach((row, index) => row.classList.toggle('is-highlighted', index === this.highlightIndex));
			rows[this.highlightIndex]?.scrollIntoView({ block: 'nearest' });
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			const target = this.highlightIndex >= 0 ? rows[this.highlightIndex] : rows[0];
			target?.click();
		}
	}
}
