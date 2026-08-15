/**
 * A small modal collecting just a project name. Brand-new projects are
 * created entirely in IndexedDB (no OS folder involved — see
 * SessionController.newProject()), so a name is the only input needed.
 * Resolves to the trimmed name, or null if the user cancelled.
 */
export function openNewProjectDialog(defaultName = 'NewProject'): Promise<string | null> {
	return new Promise(resolve => {
		const backdrop = document.createElement('div');
		backdrop.className = 'new-project-dialog-backdrop';
		const dialog = document.createElement('div');
		dialog.className = 'new-project-dialog';

		const heading = document.createElement('h3');
		heading.textContent = 'New Project';

		const label = document.createElement('label');
		const caption = document.createElement('span');
		caption.textContent = 'Project name';
		const input = document.createElement('input');
		input.type = 'text';
		input.value = defaultName;
		label.append(caption, input);

		const error = document.createElement('p');
		error.className = 'new-project-dialog-error hidden';

		const finish = (value: string | null): void => {
			backdrop.remove();
			document.removeEventListener('keydown', onKeyDown);
			resolve(value);
		};

		const submit = (): void => {
			const name = input.value.trim();
			if (!name) {
				error.textContent = 'Enter a project name.';
				error.classList.remove('hidden');
				return;
			}
			if (/[\\/:*?"<>|]/.test(name)) {
				error.textContent = 'Project name can\'t contain \\ / : * ? " < > |';
				error.classList.remove('hidden');
				return;
			}
			finish(name);
		};

		function onKeyDown(event: KeyboardEvent): void {
			if (event.key === 'Escape') finish(null);
		}

		input.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });

		const actions = document.createElement('div');
		actions.className = 'table-modal-actions';
		const cancelButton = document.createElement('button');
		cancelButton.type = 'button';
		cancelButton.textContent = 'Cancel';
		cancelButton.addEventListener('click', () => finish(null));
		const createButton = document.createElement('button');
		createButton.type = 'button';
		createButton.className = 'primary';
		createButton.textContent = 'Create';
		createButton.addEventListener('click', submit);
		actions.append(cancelButton, createButton);

		dialog.append(heading, label, error, actions);
		backdrop.append(dialog);
		backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) finish(null); });
		document.addEventListener('keydown', onKeyDown);
		document.body.append(backdrop);
		input.focus();
		input.select();
	});
}
