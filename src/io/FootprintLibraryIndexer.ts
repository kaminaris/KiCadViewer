import type {
	FootprintDirectoryHandle,
	FootprintLibraryCache,
	FootprintLibraryProgress,
	FootprintLibrarySummary
} from './FootprintLibraryCache';

export interface FootprintLibraryIndexerDeps {
	setStatus(message: string): void;
	indexFootprintsButton: HTMLButtonElement;
	footprintDirectoryInput: HTMLInputElement;
}

export class FootprintLibraryIndexer {
	protected readonly progressModalEl = document.getElementById('footprint-index-progress-modal') as HTMLDivElement;
	protected readonly progressFillEl = document.getElementById('footprint-index-progress-fill') as HTMLDivElement;
	protected readonly progressLabelEl = document.getElementById('footprint-index-progress-label') as HTMLDivElement;

	constructor(
		protected readonly cache: FootprintLibraryCache,
		protected readonly deps: FootprintLibraryIndexerDeps
	) {}

	async refreshButton(): Promise<void> {
		try {
			const summary = await this.cache.getSummary();
			if (summary) {
				this.deps.indexFootprintsButton.title = `${ this.summaryLabel(summary) } Click to rescan.`;
			}
		}
		catch {
			// IndexedDB may be disabled by browser policy.
		}
	}

	async chooseDirectory(): Promise<void> {
		const picker = (window as Window & {
			showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FootprintDirectoryHandle>;
		}).showDirectoryPicker;
		if (!picker) {
			this.deps.footprintDirectoryInput.value = '';
			this.deps.footprintDirectoryInput.click();
			return;
		}
		this.deps.indexFootprintsButton.disabled = true;
		try {
			const directory = await picker({ mode: 'read' });
			this.showProgress();
			const summary = await this.cache.indexDirectory(directory, progress => this.reportProgress(progress));
			this.finishProgress(summary);
		}
		catch (error) {
			this.hideProgress();
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				this.deps.setStatus(error instanceof Error ? error.message : String(error));
			}
		}
		finally {
			this.deps.indexFootprintsButton.disabled = false;
		}
	}

	async indexFallbackDirectory(files: FileList): Promise<void> {
		this.deps.indexFootprintsButton.disabled = true;
		this.showProgress();
		try {
			const firstPath = (files[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
			const rootName = firstPath?.split('/')[0] || 'Selected footprints directory';
			const summary = await this.cache.indexFiles(files, rootName, progress => this.reportProgress(progress));
			this.finishProgress(summary);
		}
		catch (error) {
			this.hideProgress();
			this.deps.setStatus(error instanceof Error ? error.message : String(error));
		}
		finally {
			this.deps.indexFootprintsButton.disabled = false;
			this.deps.footprintDirectoryInput.value = '';
		}
	}

	protected summaryLabel(summary: FootprintLibrarySummary): string {
		const errors = summary.errorCount ? `, ${ summary.errorCount } failed` : '';
		return `Indexed ${ summary.footprintCount } footprints from ${ summary.fileCount } files${ errors }.`;
	}

	protected showProgress(): void {
		this.progressModalEl.classList.remove('hidden');
		this.progressFillEl.style.width = '0%';
		this.progressLabelEl.textContent = 'Starting…';
	}

	protected hideProgress(): void {
		this.progressModalEl.classList.add('hidden');
	}

	protected finishProgress(summary: FootprintLibrarySummary): void {
		this.hideProgress();
		const label = this.summaryLabel(summary);
		this.deps.setStatus(label);
		this.deps.indexFootprintsButton.title = `${ label } Click to rescan.`;
		console.log(`[footprint-library] ${ label }`);
	}

	protected reportProgress(progress: FootprintLibraryProgress): void {
		const total = progress.totalFiles ?? 0;
		this.progressFillEl.style.width = `${ total > 0 ? (progress.processedFiles / total) * 100 : 0 }%`;
		this.progressLabelEl.textContent = total
			? `${ progress.processedFiles } / ${ total } — ${ progress.fileName }`
			: `${ progress.processedFiles } — ${ progress.fileName }`;
		if (progress.error) {
			console.warn(`[footprint-library] Failed to index "${ progress.fileName }": ${ progress.error }`);
		}
	}
}
