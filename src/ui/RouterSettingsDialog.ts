import { defaultRouterSettings, type RouterMode, type RouterSettings } from '../app/ActiveDocument';

export interface RouterSettingsDialogCallbacks {
	getRouterSettings(): RouterSettings;

	setRouterSettings(settings: RouterSettings): void;
}

/** Route → Interactive Router Settings — matches real KiCad's
 *  DIALOG_PNS_SETTINGS layout: a Mode radio group (each option's own
 *  sub-checkboxes greyed out unless that mode is selected, same as the real
 *  dialog) alongside a General Options checkbox column. Reuses the
 *  PreferencesDialog's `.preferences-*` shell classes (this app's one
 *  existing "small settings modal" precedent) rather than inventing a
 *  second modal skin — only `.router-settings-*` is new, for the two-column
 *  body layout the real dialog uses instead of Preferences' left-nav one. */
export class RouterSettingsDialog {
	protected readonly element = document.createElement('div');
	protected draft: RouterSettings = defaultRouterSettings();

	constructor(protected readonly callbacks: RouterSettingsDialogCallbacks) {
		this.element.className = 'preferences-modal router-settings-modal hidden';
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-modal', 'true');
		this.element.setAttribute('aria-labelledby', 'router-settings-title');
		document.body.appendChild(this.element);
	}

	open(): void {
		this.draft = { ...this.callbacks.getRouterSettings() };
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
		heading.id = 'router-settings-title';
		heading.textContent = 'Interactive Router Settings';
		const close = this.button('×', () => this.close());
		close.className = 'preferences-close';
		close.setAttribute('aria-label', 'Close router settings');
		title.append(heading, close);

		const body = document.createElement('div');
		body.className = 'router-settings-body';
		body.append(this.modeSection(), this.generalOptionsSection());

		const footer = document.createElement('footer');
		footer.className = 'preferences-footer';
		const spacer = document.createElement('span');
		spacer.className = 'preferences-spacer';
		footer.append(
			spacer, this.button('Cancel', () => this.close()),
			this.button('OK', () => {
				this.apply();
				this.close();
			})
		);

		this.element.replaceChildren(title, body, footer);
	}

	protected modeSection(): HTMLElement {
		const section = document.createElement('fieldset');
		section.className = 'router-settings-mode preferences-page';
		const legend = document.createElement('h3');
		legend.textContent = 'Mode';
		section.appendChild(legend);

		section.append(
			this.modeOption('highlight', 'Highlight collisions', [
				this.subCheckbox(
					'Free angle mode', this.draft.mode === 'highlight', this.draft.freeAngleMode,
					checked => { this.draft.freeAngleMode = checked; }
				),
				this.subCheckbox(
					'Allow DRC violations', this.draft.mode === 'highlight', this.draft.allowDrcViolations,
					checked => { this.draft.allowDrcViolations = checked; }
				)
			]),
			this.modeOption('shove', 'Shove', [
				this.subCheckbox(
					'Shove vias', this.draft.mode === 'shove', this.draft.shoveVias,
					checked => { this.draft.shoveVias = checked; }
				),
				this.subCheckbox(
					'Jump over obstacles', this.draft.mode === 'shove', this.draft.jumpOverObstacles,
					checked => { this.draft.jumpOverObstacles = checked; }
				)
			]),
			this.modeOption('walkaround', 'Walk around', [])
		);
		return section;
	}

	protected modeOption(mode: RouterMode, label: string, subOptions: HTMLElement[]): HTMLElement {
		const wrapper = document.createElement('div');
		wrapper.className = 'router-settings-mode-option';
		const option = document.createElement('label');
		const input = document.createElement('input');
		input.type = 'radio';
		input.name = 'router-mode';
		input.value = mode;
		input.checked = this.draft.mode === mode;
		input.addEventListener('change', () => {
			this.draft.mode = mode;
			this.render();
		});
		option.append(input, ` ${ label }`);
		wrapper.appendChild(option);
		if (subOptions.length > 0) {
			const subList = document.createElement('div');
			subList.className = 'router-settings-sub-options';
			subList.append(...subOptions);
			wrapper.appendChild(subList);
		}
		return wrapper;
	}

	protected generalOptionsSection(): HTMLElement {
		const section = document.createElement('div');
		section.className = 'router-settings-general preferences-page';
		const heading = document.createElement('h3');
		heading.textContent = 'General Options';
		section.appendChild(heading);
		section.append(
			this.checkbox(
				'Remove redundant tracks', this.draft.removeRedundantTracks,
				checked => { this.draft.removeRedundantTracks = checked; }
			),
			this.checkbox(
				'Optimize pad connections', this.draft.optimizePadConnections,
				checked => { this.draft.optimizePadConnections = checked; }
			),
			this.checkbox(
				'Smooth dragged segments', this.draft.smoothDraggedSegments,
				checked => { this.draft.smoothDraggedSegments = checked; }
			),
			this.checkbox(
				'Optimize entire track being dragged', this.draft.optimizeEntireDraggedTrack,
				checked => { this.draft.optimizeEntireDraggedTrack = checked; }
			),
			this.checkbox(
				'Use mouse path to set track posture', this.draft.useMousePathForPosture,
				checked => { this.draft.useMousePathForPosture = checked; }
			),
			this.checkbox(
				'Fix all segments on click', this.draft.fixAllSegmentsOnClick,
				checked => { this.draft.fixAllSegmentsOnClick = checked; }
			)
		);
		return section;
	}

	protected subCheckbox(
		label: string, enabled: boolean, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
		const field = this.checkbox(label, checked, onChange);
		const input = field.querySelector('input')!;
		input.disabled = !enabled;
		return field;
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
		this.callbacks.setRouterSettings(this.draft);
	}
}
