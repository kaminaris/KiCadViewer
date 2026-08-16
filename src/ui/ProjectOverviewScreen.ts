import type { ProjectRegistry, ProjectRecord } from '../app/ProjectRegistry';
import type { DocumentKind }                   from '../app/ActiveDocument';

export interface ProjectOverviewScreenCallbacks {
	openView(projectId: string, view: DocumentKind): void;

	openViewNewTab(projectId: string, view: DocumentKind): void;

	openSymbolEditor(projectId: string): void;

	back(): void;
}

/** Project metadata + view tiles. Symbol editor is now a live route for the
 *  first milestone; footprint editing remains a placeholder. Shown for
 *  `?project=<id>` with no `view` param. */
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

		const shell = document.createElement('div');
		shell.className = 'project-overview-shell';

		const header = document.createElement('header');
		header.className = 'project-overview-header';
		const titleRow = document.createElement('div');
		titleRow.className = 'project-overview-title-row';
		const title = document.createElement('h1');
		title.textContent = project.name;
		const kindLabel = project.kind === 'folder' ? 'Folder project' :
			project.kind === 'imported' ? 'Imported project' : 'Browser-only project';
		const badge = document.createElement('span');
		badge.className = 'project-overview-badge';
		badge.textContent = kindLabel;
		titleRow.append(title, badge);

		const meta = document.createElement('div');
		meta.className = 'project-overview-meta';
		const sheetLabel = project.sheetCount ?
			`${ project.sheetCount } sheet${ project.sheetCount === 1 ? '' : 's' }` : 'No sheets yet';
		const openedLabel = new Date(project.lastOpenedAt).toLocaleString([], {
			dateStyle: 'medium',
			timeStyle: 'short'
		});
		meta.textContent = `${ sheetLabel } • Last opened ${ openedLabel }`;
		header.append(titleRow, meta);

		const summary = document.createElement('div');
		summary.className = 'project-overview-summary';
		const stats = [
			{ label: 'Sheets', value: String(project.sheetCount ?? 0) },
			{
				label: 'Type',
				value: project.kind === 'folder' ? 'Folder' : project.kind === 'imported' ? 'Imported' : 'Browser'
			},
			{
				label: 'Opened',
				value: new Date(project.lastOpenedAt).toLocaleDateString(
					[],
					{ month: 'short', day: 'numeric', year: 'numeric' }
				)
			}
		];
		for (const stat of stats) {
			const statEl = document.createElement('div');
			statEl.className = 'project-overview-stat';
			const label = document.createElement('div');
			label.className = 'project-overview-stat-label';
			label.textContent = stat.label;
			const value = document.createElement('div');
			value.className = 'project-overview-stat-value';
			value.textContent = stat.value;
			statEl.append(label, value);
			summary.appendChild(statEl);
		}

		const tiles = document.createElement('div');
		tiles.className = 'project-overview-tiles';
		tiles.append(
			this.buildTile(project.id, 'Schematic', 'schematic', 'Edit sheets, symbols, and project logic.'),
			this.buildTile(project.id, 'PCB', 'board', 'Review board layout and manufacturing data.'),
			this.buildCustomTile(
				project.id, 'Symbol Editor', 'Edit or inspect a cached library symbol.',
				() => this.callbacks.openSymbolEditor(project.id)
			),
			this.buildDisabledTile('Footprint Editor', 'Footprint library authoring and management.')
		);

		shell.append(header, summary, tiles);
		wrap.append(back, shell);
		return wrap;
	}

	/** A `<div role="button">`, not a real `<button>` — it needs to contain
	 *  the "open in new tab" affordance as an actually-nested `<button>`,
	 *  and a button can't legally contain another button (browsers
	 *  silently reparent it out, breaking both the layout and its click
	 *  handler). Keyboard activation (Enter/Space) is wired manually to
	 *  keep it as accessible as a real button. */
	protected buildTile(projectId: string, label: string, view: DocumentKind, description: string): HTMLElement {
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

		const textEl = document.createElement('div');
		textEl.className = 'project-tile-copy';
		const titleEl = document.createElement('div');
		titleEl.className = 'project-tile-title';
		titleEl.textContent = label;
		const subEl = document.createElement('div');
		subEl.className = 'project-tile-subtitle';
		subEl.textContent = description;
		textEl.append(titleEl, subEl);

		const newTabBtn = document.createElement('button');
		newTabBtn.type = 'button';
		newTabBtn.className = 'project-tile-new-tab';
		newTabBtn.title = 'Open in a new tab';
		newTabBtn.textContent = '⧉';
		newTabBtn.addEventListener('click', event => {
			event.stopPropagation();
			this.callbacks.openViewNewTab(projectId, view);
		});

		tile.append(textEl, newTabBtn);
		return tile;
	}

	protected buildCustomTile(
		projectId: string, label: string, description: string, onActivate: () => void): HTMLElement {
		const tile = document.createElement('div');
		tile.className = 'project-tile';
		tile.setAttribute('role', 'button');
		tile.tabIndex = 0;
		const activate = () => onActivate();
		tile.addEventListener('click', activate);
		tile.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				activate();
			}
		});

		const textEl = document.createElement('div');
		textEl.className = 'project-tile-copy';
		const titleEl = document.createElement('div');
		titleEl.className = 'project-tile-title';
		titleEl.textContent = label;
		const subEl = document.createElement('div');
		subEl.className = 'project-tile-subtitle';
		subEl.textContent = description;
		textEl.append(titleEl, subEl);

		const badge = document.createElement('div');
		badge.className = 'project-tile-soon';
		badge.textContent = 'Open';
		tile.append(textEl, badge);
		return tile;
	}

	protected buildDisabledTile(label: string, description: string): HTMLElement {
		const tile = document.createElement('div');
		tile.className = 'project-tile project-tile-disabled';
		tile.setAttribute('aria-disabled', 'true');
		const textEl = document.createElement('div');
		textEl.className = 'project-tile-copy';
		const titleEl = document.createElement('div');
		titleEl.className = 'project-tile-title';
		titleEl.textContent = label;
		const subtitle = document.createElement('div');
		subtitle.className = 'project-tile-subtitle';
		subtitle.textContent = description;
		const soon = document.createElement('div');
		soon.className = 'project-tile-soon';
		soon.textContent = 'Coming soon';
		textEl.append(titleEl, subtitle);
		tile.append(textEl, soon);
		return tile;
	}
}
