import {
	DEFAULT_SETTINGS,
	type AppSettings,
	type DisplayUnit,
	type Settings,
	type ThemePreference,
	type ToolbarIconSize,
	type ZoomSpeed
} from '../app/Settings';
import {
	defaultShortcuts,
	normalizeShortcutEvent,
	SHORTCUT_ACTIONS,
	type ShortcutActionId
} from '../app/Shortcuts';
import {
	SCHEMATIC_COLOR_FIELDS,
	SCHEMATIC_THEME_PRESETS,
	themeColor,
	type SchematicThemeId
} from '../app/SchematicThemes';

type PreferencesPage = 'common' | 'mouse' | 'editor' | 'pcb-editor' | 'colors' | 'hotkeys';

export interface PreferencesDialogCallbacks {
	applyPreferences(): void;
}

/** KiCad-inspired application preferences with a small set of browser-native settings. */
export class PreferencesDialog {
	protected readonly element = document.createElement('div');
	protected readonly pageContent = document.createElement('div');
	protected draft: AppSettings;
	protected page: PreferencesPage = 'common';

	constructor(protected readonly settings: Settings, protected readonly callbacks: PreferencesDialogCallbacks) {
		this.draft = this.clone(settings.current);
		this.element.className = 'preferences-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-labelledby', 'preferences-title');
		document.body.appendChild(this.element);
	}

	open(): void {
		this.draft = this.clone(this.settings.current);
		this.page = 'common';
		this.render();
		this.element.classList.remove('hidden');
	}

	protected close(): void {
		this.element.classList.add('hidden');
	}

	protected render(): void {
		const title = document.createElement('div');
		title.className = 'preferences-titlebar';
		const heading = document.createElement('h2');
		heading.id = 'preferences-title';
		heading.textContent = 'Preferences';
		const close = this.button('×', () => this.close());
		close.className = 'preferences-close';
		close.setAttribute('aria-label', 'Close preferences');
		title.append(heading, close);

		const navigation = document.createElement('nav');
		navigation.className = 'preferences-nav';
		for (const [id, label] of [['common', 'Common'], ['mouse', 'Mouse and Touchpad'], ['editor', 'Schematic Editor'], ['pcb-editor', 'PCB Editor'], ['colors', 'Colors'], ['hotkeys', 'Hotkeys']] as const) {
			const button = this.button(label, () => { this.page = id; this.render(); });
			button.className = `preferences-nav-item${ this.page === id ? ' active' : '' }`;
			navigation.appendChild(button);
		}

		this.pageContent.className = 'preferences-content';
		this.pageContent.replaceChildren(this.page === 'common' ? this.commonPage()
			: this.page === 'mouse' ? this.mousePage()
				: this.page === 'editor' ? this.editorPage()
					: this.page === 'pcb-editor' ? this.pcbEditorPage()
					: this.page === 'colors' ? this.colorsPage() : this.hotkeysPage());
		const body = document.createElement('div');
		body.className = 'preferences-body';
		body.append(navigation, this.pageContent);

		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const reset = this.button('Reset All Preferences', () => {
			this.draft = this.clone(DEFAULT_SETTINGS);
			this.render();
		});
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		footer.append(reset, spacer, this.button('Cancel', () => this.close()), this.button('Apply', () => this.apply()),
			this.button('OK', () => { this.apply(); this.close(); }));

		this.element.replaceChildren(title, body, footer);
	}

	protected commonPage(): HTMLElement {
		const page = this.pageSection('Common');
		page.append(
			this.radioGroup<ThemePreference>('App theme', 'theme', [
				['system', 'Automatic'], ['dark', 'Dark'], ['light', 'Light']
			], value => { this.draft.theme = value; }),
			this.radioGroup<ToolbarIconSize>('Toolbar icon size', 'toolbar-size', [
				['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']
			], value => { this.draft.toolbarIconSize = value; }),
			this.radioGroup<DisplayUnit>('Coordinate display units', 'display-unit', [
				['mm', 'Millimetres'], ['mil', 'Mils']
			], value => { this.draft.displayUnit = value; }),
			this.checkbox('Show status bar', this.draft.showStatusBar,
				checked => { this.draft.showStatusBar = checked; })
		);
		const description = document.createElement('p');
		description.className = 'preferences-note';
		description.textContent = 'Automatic follows your operating system’s color preference. These settings apply across every KiOnline project.';
		page.appendChild(description);
		return page;
	}

	protected colorsPage(): HTMLElement {
		const page = this.pageSection('Colors');
		const theme = document.createElement('label');
		theme.className = 'preferences-field';
		theme.append('Schematic color theme');
		const select = document.createElement('select');
		for (const [id, preset] of Object.entries(SCHEMATIC_THEME_PRESETS) as [SchematicThemeId, typeof SCHEMATIC_THEME_PRESETS[SchematicThemeId]][]) {
			select.appendChild(new Option(preset.label, id, false, id === this.draft.schematicTheme));
		}
		select.addEventListener('change', () => {
			this.draft.schematicTheme = select.value as SchematicThemeId;
			this.draft.schematicColorOverrides = {};
			this.render();
		});
		theme.appendChild(select);
		page.appendChild(theme);
		const note = document.createElement('p');
		note.className = 'preferences-note';
		note.textContent = 'KiCad Default and Classic are based on the built-in Eeschema palettes. Changing a swatch creates an app-wide custom override for that theme.';
		page.appendChild(note);
		const fields = document.createElement('div');
		fields.className = 'preferences-color-fields';
		for (const [name, label] of SCHEMATIC_COLOR_FIELDS) {
			fields.appendChild(this.colorField(name, label));
		}
		page.appendChild(fields);
		const reset = this.button('Reset Theme Colors', () => {
			this.draft.schematicColorOverrides = {};
			this.render();
		});
		reset.className = 'preferences-secondary-action';
		page.appendChild(reset);
		return page;
	}

	protected colorField(name: keyof AppSettings['schematicColorOverrides'], label: string): HTMLElement {
		const field = document.createElement('label');
		field.className = 'preferences-color-field';
		const text = document.createElement('span');
		text.textContent = label;
		const input = document.createElement('input');
		input.type = 'color';
		input.value = themeColor(this.draft.schematicTheme, this.draft.schematicColorOverrides, name);
		input.addEventListener('input', () => { this.draft.schematicColorOverrides[name] = input.value; });
		field.append(text, input);
		return field;
	}

	protected mousePage(): HTMLElement {
		const page = this.pageSection('Mouse and Touchpad');
		page.append(
			this.radioGroup<ZoomSpeed>('Mouse wheel zoom speed', 'zoom-speed', [
				['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']
			], value => { this.draft.zoomSpeed = value; }),
			this.checkbox('Invert mouse wheel zoom direction', this.draft.invertZoom,
				checked => { this.draft.invertZoom = checked; }),
			this.checkbox('Center and warp cursor on zoom', this.draft.centerAndWarpCursorOnZoom,
				checked => { this.draft.centerAndWarpCursorOnZoom = checked; }),
			this.checkbox('Use a crosshair cursor on the canvas', this.draft.crosshairCursor,
				checked => { this.draft.crosshairCursor = checked; })
		);
		const note = document.createElement('p');
		note.className = 'preferences-note';
		note.textContent = 'When enabled, zoom centers the view like KiCad. Browsers do not permit apps to move the physical mouse pointer.';
		page.appendChild(note);
		return page;
	}

	protected editorPage(): HTMLElement {
		const page = this.pageSection('Schematic Editor');
		const grid = document.createElement('label');
		grid.className = 'preferences-field';
		grid.append('Default grid spacing');
		const select = document.createElement('select');
		for (const [value, label] of [['0.635', '0.635 mm (25 mil)'], ['1.27', '1.27 mm (50 mil)'],
			['2.54', '2.54 mm (100 mil)'], ['5.08', '5.08 mm (200 mil)']]) {
			const option = new Option(label, value, false, Number(value) === this.draft.schematicGridSpacingMm);
			select.appendChild(option);
		}
		select.addEventListener('change', () => { this.draft.schematicGridSpacingMm = Number(select.value); });
		grid.appendChild(select);

		const snap = this.checkbox('Snap newly placed and edited items to the grid', this.draft.schematicGridSnapping,
			checked => { this.draft.schematicGridSnapping = checked; });
		const power = document.createElement('label');
		power.className = 'preferences-field';
		power.append('Default power symbol');
		const powerSelect = document.createElement('select');
		for (const [value, label] of [['gnd', 'GND'], ['flag', 'PWR_FLAG'], ['rail', 'Power rail']]) {
			powerSelect.appendChild(new Option(label, value, false, value === this.draft.powerKind));
		}
		powerSelect.addEventListener('change', () => { this.draft.powerKind = powerSelect.value as AppSettings['powerKind']; });
		power.appendChild(powerSelect);
		page.append(grid, snap, power);
		return page;
	}

	protected pcbEditorPage(): HTMLElement {
		const page = this.pageSection('PCB Editor');
		const grid = document.createElement('label');
		grid.className = 'preferences-field';
		grid.append('Default PCB grid spacing');
		const select = document.createElement('select');
		for (const [value, label] of [['0.05', '0.05 mm'], ['0.1', '0.10 mm'], ['0.2', '0.20 mm'], ['0.25', '0.25 mm'], ['0.5', '0.50 mm'], ['1', '1.00 mm']]) {
			select.appendChild(new Option(label, value, false, Number(value) === this.draft.boardGridSpacingMm));
		}
		select.addEventListener('change', () => { this.draft.boardGridSpacingMm = Number(select.value); });
		grid.appendChild(select);
		page.append(grid, this.checkbox('Snap moved footprints, tracks, and vias to the PCB grid', this.draft.boardGridSnapping,
			checked => { this.draft.boardGridSnapping = checked; }));
		return page;
	}

	protected hotkeysPage(): HTMLElement {
		const page = this.pageSection('Hotkeys');
		const note = document.createElement('p');
		note.className = 'preferences-note';
		note.textContent = 'Click a shortcut and press the new key combination. A shortcut cannot be assigned to more than one action.';
		page.appendChild(note);
		const reset = this.button('Reset Hotkeys to Defaults', () => { this.draft.shortcuts = defaultShortcuts(); this.render(); });
		reset.className = 'preferences-secondary-action';
		page.appendChild(reset);
		for (const category of ['Common', 'Schematic Editor'] as const) {
			const heading = document.createElement('h3');
			heading.textContent = category;
			const list = document.createElement('div');
			list.className = 'hotkey-list';
			for (const action of SHORTCUT_ACTIONS.filter(candidate => candidate.category === category)) {
				list.appendChild(this.hotkeyRow(action.id, action.label));
			}
			page.append(heading, list);
		}
		return page;
	}

	protected hotkeyRow(action: ShortcutActionId, label: string): HTMLElement {
		const row = document.createElement('label');
		row.className = 'hotkey-row';
		const text = document.createElement('span');
		text.textContent = label;
		const input = document.createElement('input');
		input.type = 'text';
		input.readOnly = true;
		input.value = this.draft.shortcuts[action];
		input.setAttribute('aria-label', `${ label } shortcut`);
		input.addEventListener('keydown', event => {
			event.preventDefault();
			if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Delete') {
				this.draft.shortcuts[action] = '';
				this.render();
				return;
			}
			const binding = normalizeShortcutEvent(event);
			if (!binding) {
				return;
			}
			const conflict = Object.entries(this.draft.shortcuts).find(([id, value]) => id !== action && value === binding);
			if (conflict) {
				input.setCustomValidity(`Already assigned to ${ SHORTCUT_ACTIONS.find(item => item.id === conflict[0])?.label ?? 'another action' }.`);
				input.reportValidity();
				return;
			}
			this.draft.shortcuts[action] = binding;
			this.render();
		});
		row.append(text, input);
		return row;
	}

	protected pageSection(title: string): HTMLElement {
		const page = document.createElement('section');
		page.className = 'preferences-page';
		const heading = document.createElement('h3');
		heading.textContent = title;
		page.appendChild(heading);
		return page;
	}

	protected radioGroup<T extends string>(label: string, name: string, options: readonly [T, string][], onChange: (value: T) => void): HTMLElement {
		const group = document.createElement('fieldset');
		group.className = 'preferences-radio-group';
		const legend = document.createElement('legend');
		legend.textContent = label;
		group.appendChild(legend);
		const current: string = name === 'theme' ? this.draft.theme
			: name === 'toolbar-size' ? this.draft.toolbarIconSize
				: name === 'display-unit' ? this.draft.displayUnit : this.draft.zoomSpeed;
		for (const [value, text] of options) {
			const option = document.createElement('label');
			const input = document.createElement('input');
			input.type = 'radio';
			input.name = name;
			input.value = value;
			input.checked = current === value;
			input.addEventListener('change', () => onChange(value));
			option.append(input, ` ${ text }`);
			group.appendChild(option);
		}
		return group;
	}

	protected checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
		const field = document.createElement('label');
		field.className = 'preferences-check';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked;
		input.addEventListener('change', () => onChange(input.checked));
		field.append(input, ` ${ label }`);
		return field;
	}

	protected button(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}

	protected apply(): void {
		this.settings.replace(this.draft);
		this.callbacks.applyPreferences();
	}

	protected clone(settings: AppSettings): AppSettings {
		return { ...settings, shortcuts: { ...settings.shortcuts } };
	}
}
