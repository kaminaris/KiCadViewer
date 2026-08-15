import type { ProjectRegistry, ProjectRecord } from '../app/ProjectRegistry';
import type { DocumentKind }                   from '../app/ActiveDocument';

export interface ProjectOverviewScreenCallbacks {
	openView(projectId: string, view: DocumentKind): void;

	openViewNewTab(projectId: string, view: DocumentKind): void;

	back(): void;
}

/** Project metadata + view tiles (Schematic/PCB live; Symbol/Footprint
 *  editor tiles are placeholders — the slot Circuit Layout re-enters into
 *  later, per the harmonic-munching-trinket plan). Shown for `?project=<id>`
 *  with no `view` param. */
export class ProjectOverviewScreen {
	constructor(
		protected readonly root: HTMLElement,
		protected readonly registry: ProjectRegistry,
		protected readonly callbacks: ProjectOverviewScreenCallbacks
	) {}

	async load(projectId: string): Promise<void> {
		const project = await this.registry.getProject(projectId);
		this.root.replaceChildren();
		if (!project) {
			const back = this.makeButton('← Back to Home', () => this.callbacks.back());
			back.className = 'project-overview-back';
			const notFound = document.createElement('p');
			notFound.className = 'project-overview-missing';
			notFound.textContent = `Unknown project "${ projectId }" — it may have been opened in a different browser, or its registry entry didn't survive a browser data clear.`;
			this.root.append(back, notFound);
			return;
		}
		this.root.appendChild(this.build(project));
	}

	protected makeButton(label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}

	protected build(project: ProjectRecord): HTMLElement {
		const wrap = document.createElement('div');
		wrap.className = 'project-overview';

		const back = this.makeButton('← Back to Home', () => this.callbacks.back());
		back.className = 'project-overview-back';

		const header = document.createElement('div');
		header.className = 'project-overview-header';
		const title = document.createElement('h1');
		title.textContent = project.name;
		const meta = document.createElement('div');
		meta.className = 'project-overview-meta';
		const kindLabel = project.kind === 'folder' ? 'Folder project' : project.kind === 'imported' ? 'Imported project' : 'Browser-only project';
		const sheetLabel = project.sheetCount ? `${ project.sheetCount } sheet(s)` : '';
		meta.textContent = [kindLabel, sheetLabel].filter(Boolean).join(' · ');
		header.append(title, meta);

		const tiles = document.createElement('div');
		tiles.className = 'project-overview-tiles';
		tiles.append(
			this.buildTile(project.id, 'Schematic', 'schematic'),
			this.buildTile(project.id, 'PCB', 'board'),
			this.buildDisabledTile('Symbol Editor'),
			this.buildDisabledTile('Footprint Editor')
		);

		wrap.append(back, header, tiles);
		return wrap;
	}

	/** A `<div role="button">`, not a real `<button>` — it needs to contain
	 *  the "open in new tab" affordance as an actually-nested `<button>`,
	 *  and a button can't legally contain another button (browsers
	 *  silently reparent it out, breaking both the layout and its click
	 *  handler). Keyboard activation (Enter/Space) is wired manually to
	 *  keep it as accessible as a real button. */
	protected buildTile(projectId: string, label: string, view: DocumentKind): HTMLElement {
		const tile = document.createElement('div');
		tile.className = 'project-tile';
		tile.setAttribute('role', 'button');
		tile.tabIndex = 0;
		const activate = () => this.callbacks.openView(projectId, view);
		tile.addEventListener('click', activate);
		tile.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				activate();
			}
		});

		const titleEl = document.createElement('div');
		titleEl.className = 'project-tile-title';
		titleEl.textContent = label;

		const newTabBtn = document.createElement('button');
		newTabBtn.type = 'button';
		newTabBtn.className = 'project-tile-new-tab';
		newTabBtn.title = 'Open in a new tab';
		newTabBtn.textContent = '⧉';
		newTabBtn.addEventListener('click', event => {
			event.stopPropagation();
			this.callbacks.openViewNewTab(projectId, view);
		});

		tile.append(titleEl, newTabBtn);
		return tile;
	}

	protected buildDisabledTile(label: string): HTMLElement {
		const tile = document.createElement('div');
		tile.className = 'project-tile project-tile-disabled';
		tile.setAttribute('aria-disabled', 'true');
		const titleEl = document.createElement('div');
		titleEl.className = 'project-tile-title';
		titleEl.textContent = label;
		const soon = document.createElement('div');
		soon.className = 'project-tile-soon';
		soon.textContent = 'Coming soon';
		tile.append(titleEl, soon);
		return tile;
	}
}
