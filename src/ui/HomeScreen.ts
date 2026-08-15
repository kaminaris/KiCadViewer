import type { ProjectRegistry, ProjectRecord } from '../app/ProjectRegistry';

export interface LibrarySummary {
	rootName: string;
	fileCount: number;
	symbolCount?: number;
	footprintCount?: number;
	errorCount: number;
}

export interface HomeScreenCallbacks {
	openFolder(): void;

	newProject(): void;

	openZip(file: File): void;

	openProject(projectId: string): void;

	/** No-project "scratch" editor — the pre-project-support single-file
	 *  open flow, still needed since a fresh Home screen would otherwise
	 *  have no path at all into that entry point. */
	openScratchEditor(): void;

	reindexSymbols(): Promise<void> | void;

	reindexFootprints(): Promise<void> | void;

	clearSymbolLibrary(): Promise<void> | void;

	clearFootprintLibrary(): Promise<void> | void;

	getSymbolLibrarySummary(): Promise<LibrarySummary | null>;

	getFootprintLibrarySummary(): Promise<LibrarySummary | null>;
}

/** Landing screen — every known project (from the registry) as a card, plus
 *  Open Folder / New Project / Open .zip actions. What a fresh browser tab
 *  shows when its URL carries no `?project=` (see Router.ts). */
export class HomeScreen {
	protected readonly listEl: HTMLDivElement;
	protected readonly libraryPanelEl: HTMLDivElement;
	protected readonly libraryModalEl: HTMLDivElement;
	protected readonly libraryModalTitleEl: HTMLHeadingElement;
	protected readonly libraryProgressFillEl: HTMLDivElement;
	protected readonly libraryProgressLabelEl: HTMLDivElement;
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

		this.libraryPanelEl = document.createElement('div');
		this.libraryPanelEl.className = 'home-library-panel';
		this.libraryPanelEl.setAttribute('aria-label', 'Library status');

		this.libraryModalEl = document.createElement('div');
		this.libraryModalEl.className = 'home-library-modal hidden';
		const modalTitle = document.createElement('h3');
		modalTitle.className = 'home-library-modal-title';
		this.libraryModalTitleEl = modalTitle;
		const track = document.createElement('div');
		track.className = 'home-library-progress-track';
		this.libraryProgressFillEl = document.createElement('div');
		this.libraryProgressFillEl.className = 'home-library-progress-fill';
		this.libraryProgressFillEl.style.width = '0%';
		track.appendChild(this.libraryProgressFillEl);
		this.libraryProgressLabelEl = document.createElement('div');
		this.libraryProgressLabelEl.className = 'home-library-progress-label';
		this.libraryProgressLabelEl.textContent = 'Starting…';
		this.libraryModalEl.append(modalTitle, track, this.libraryProgressLabelEl);

		this.listEl = document.createElement('div');
		this.listEl.className = 'home-project-list';

		this.root.append(header, this.libraryPanelEl, this.listEl, this.libraryModalEl);
	}

	showImportProgress(kind: 'Symbols' | 'Footprints', processed = 0, total = 0, fileName?: string): void {
		this.libraryModalTitleEl.textContent = `Indexing ${ kind }…`;
		this.libraryModalEl.classList.remove('hidden');
		this.libraryProgressFillEl.style.width = total > 0 ? `${ (processed / total) * 100 }%` : '0%';
		this.libraryProgressLabelEl.textContent = total > 0
			? `${ processed } / ${ total } — ${ fileName ?? 'Starting…' }`
			: fileName ? `${ processed } — ${ fileName }` : 'Starting…';
	}

	hideImportProgress(): void {
		this.libraryModalEl.classList.add('hidden');
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
		const [projects, symbolSummary, footprintSummary] = await Promise.all([
			this.registry.listProjects(),
			this.callbacks.getSymbolLibrarySummary(),
			this.callbacks.getFootprintLibrarySummary(),
		]);
		this.renderLibraryStatus(symbolSummary, footprintSummary);
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

	protected renderLibraryStatus(symbolSummary: LibrarySummary | null, footprintSummary: LibrarySummary | null): void {
		this.libraryPanelEl.replaceChildren();
		const title = document.createElement('div');
		title.className = 'home-library-title';
		title.textContent = 'Library status';
		this.libraryPanelEl.appendChild(title);

		this.libraryPanelEl.appendChild(this.buildLibraryCard(
			'Symbols',
			symbolSummary,
			count => `${ count } symbol(s) loaded`,
			'No symbols are indexed yet. Re-upload your symbol library folder to populate the database.',
			() => this.callbacks.reindexSymbols(),
			() => this.callbacks.clearSymbolLibrary()
		));

		this.libraryPanelEl.appendChild(this.buildLibraryCard(
			'Footprints',
			footprintSummary,
			count => `${ count } footprint(s) loaded`,
			'No footprints are indexed yet. Re-upload your footprint library folder to populate the database.',
			() => this.callbacks.reindexFootprints(),
			() => this.callbacks.clearFootprintLibrary()
		));
	}

	protected buildLibraryCard(
		label: string,
		summary: LibrarySummary | null,
		countText: (count: number) => string,
		emptyText: string,
		onReindex: () => Promise<void> | void,
		onClear: () => Promise<void> | void
	): HTMLElement {
		const card = document.createElement('section');
		card.className = 'home-library-card';

		const header = document.createElement('div');
		header.className = 'home-library-header';
		const name = document.createElement('div');
		name.className = 'home-library-name';
		name.textContent = label;
		const badge = document.createElement('span');
		badge.className = 'home-library-badge';
		const count = summary?.symbolCount ?? summary?.footprintCount ?? 0;
		badge.textContent = count ? 'Ready' : 'Empty';
		header.append(name, badge);

		const body = document.createElement('div');
		body.className = 'home-library-body';
		if (summary && count > 0) {
			const text = document.createElement('div');
			text.className = 'home-library-copy';
			text.textContent = countText(count);
			body.appendChild(text);
		} else {
			const warn = document.createElement('div');
			warn.className = 'home-library-warning';
			warn.textContent = emptyText;
			body.appendChild(warn);
		}

		const actions = document.createElement('div');
		actions.className = 'home-library-actions';
		const action = this.makeButton(count ? 'Re-upload' : 'Upload', () => { void onReindex(); });
		action.className = 'home-library-action';
		const clear = this.makeButton('Clear', () => { void onClear(); });
		clear.className = 'home-library-clear';
		if (count === 0) {
			clear.disabled = true;
		}
		actions.append(action, clear);
		card.append(header, body, actions);
		return card;
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
		const kindLabel = project.kind === 'folder' ? 'Folder' : project.kind === 'imported' ? 'Imported' : 'Browser';
		const sheetLabel = project.sheetCount ? `${ project.sheetCount } sheet(s)` : '';
		const dateLabel = new Date(project.lastOpenedAt).toLocaleString();
		meta.textContent = [kindLabel, sheetLabel, `Opened ${ dateLabel }`].filter(Boolean).join(' · ');

		card.append(name, meta);
		return card;
	}
}
