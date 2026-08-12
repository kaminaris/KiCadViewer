import type { ProjectRegistry, ProjectRecord } from '../app/ProjectRegistry';

export interface HomeScreenCallbacks {
	openFolder(): void;

	newProject(): void;

	openZip(file: File): void;

	openProject(projectId: string): void;

	/** No-project "scratch" editor — the pre-project-support single-file
	 *  open flow, still needed since a fresh Home screen would otherwise
	 *  have no path at all into that entry point. */
	openScratchEditor(): void;
}

/** Landing screen — every known project (from the registry) as a card, plus
 *  Open Folder / New Project / Open .zip actions. What a fresh browser tab
 *  shows when its URL carries no `?project=` (see Router.ts). */
export class HomeScreen {
	protected readonly listEl: HTMLDivElement;
	protected readonly zipInput: HTMLInputElement;

	constructor(
		protected readonly root: HTMLElement,
		protected readonly registry: ProjectRegistry,
		protected readonly callbacks: HomeScreenCallbacks
	) {
		this.root.replaceChildren();

		const header = document.createElement('div');
		header.className = 'home-header';

		const title = document.createElement('div');
		title.className = 'home-title';
		title.textContent = 'KiOnline';

		const actions = document.createElement('div');
		actions.className = 'home-actions';
		const openFolderBtn = this.makeButton('Open Project Folder', () => this.callbacks.openFolder());
		const newProjectBtn = this.makeButton('New Project', () => this.callbacks.newProject());

		const openZipLabel = document.createElement('label');
		openZipLabel.className = 'file-btn';
		openZipLabel.textContent = 'Open Project (.zip)';
		this.zipInput = document.createElement('input');
		this.zipInput.type = 'file';
		this.zipInput.accept = '.zip';
		this.zipInput.hidden = true;
		this.zipInput.addEventListener('change', () => {
			const file = this.zipInput.files?.[0];
			this.zipInput.value = '';
			if (file) {
				this.callbacks.openZip(file);
			}
		});
		openZipLabel.appendChild(this.zipInput);

		const scratchBtn = this.makeButton('Open a Single File', () => this.callbacks.openScratchEditor());
		scratchBtn.title = 'Open one .kicad_sch / .kicad_pcb with no project behind it';

		actions.append(openFolderBtn, newProjectBtn, openZipLabel, scratchBtn);
		header.append(title, actions);

		this.listEl = document.createElement('div');
		this.listEl.className = 'home-project-list';

		this.root.append(header, this.listEl);
	}

	protected makeButton(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}

	/** Re-reads the registry and re-renders the card list — called whenever
	 *  the router shows this screen, so a project opened elsewhere (another
	 *  tab, or this tab a moment ago) always appears without a reload. */
	async refresh(): Promise<void> {
		const projects = await this.registry.listProjects();
		this.listEl.replaceChildren();
		if (!projects.length) {
			const empty = document.createElement('p');
			empty.className = 'home-empty';
			empty.textContent = 'No projects yet — open a folder, a .zip, or create a new project to get started.';
			this.listEl.appendChild(empty);
			return;
		}
		for (const project of projects) {
			this.listEl.appendChild(this.buildCard(project));
		}
	}

	protected buildCard(project: ProjectRecord): HTMLElement {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'project-card';
		card.addEventListener('click', () => this.callbacks.openProject(project.id));

		const name = document.createElement('div');
		name.className = 'project-card-name';
		name.textContent = project.name;

		const meta = document.createElement('div');
		meta.className = 'project-card-meta';
		const kindLabel = project.kind === 'folder' ? 'Folder' : 'Imported';
		const sheetLabel = project.sheetCount ? `${ project.sheetCount } sheet(s)` : '';
		const dateLabel = new Date(project.lastOpenedAt).toLocaleString();
		meta.textContent = [kindLabel, sheetLabel, `Opened ${ dateLabel }`].filter(Boolean).join(' · ');

		card.append(name, meta);
		return card;
	}
}
