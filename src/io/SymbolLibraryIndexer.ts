import type {
	SymbolLibraryCache,
	SymbolDirectoryHandle,
	SymbolLibraryProgress,
	SymbolLibrarySummary
} from './SymbolLibraryCache';

export interface SymbolLibraryIndexerDeps {
	setStatus(message: string): void;
	indexSymbolsButton: HTMLButtonElement;
	symbolDirectoryInput: HTMLInputElement;
}

/** Owns symbol library directory scanning and button/progress feedback. */
export class SymbolLibraryIndexer {
	protected readonly progressModalEl = document.getElementById('symbol-index-progress-modal') as HTMLDivElement;
	protected readonly progressFillEl = document.getElementById('symbol-index-progress-fill') as HTMLDivElement;
	protected readonly progressLabelEl = document.getElementById('symbol-index-progress-label') as HTMLDivElement;

	constructor(
		protected readonly cache: SymbolLibraryCache,
		protected readonly deps: SymbolLibraryIndexerDeps
	) {}

	async refreshButton(): Promise<void> {
		try {
			const summary = await this.cache.getSummary();
			if (summary) {
				this.deps.indexSymbolsButton.title = `${ this.summaryLabel(summary) } Click to rescan.`;
			}
		}
		catch {
			// IndexedDB may be disabled by a protected browsing policy.
		}
	}

	async chooseDirectory(): Promise<void> {
		const picker = (window as Window & {
			showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<SymbolDirectoryHandle>;
		}).showDirectoryPicker;
		if (!picker) {
			this.deps.symbolDirectoryInput.value = '';
			this.deps.symbolDirectoryInput.click();
			return;
		}
		this.deps.indexSymbolsButton.disabled = true;
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
			this.deps.indexSymbolsButton.disabled = false;
		}
	}

	async indexFallbackDirectory(files: FileList): Promise<void> {
		this.deps.indexSymbolsButton.disabled = true;
		this.showProgress();
		try {
			const firstPath = (files[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
			const rootName = firstPath?.split('/')[0] || 'Selected symbols directory';
			const summary = await this.cache.indexFiles(files, rootName, progress => this.reportProgress(progress));
			this.finishProgress(summary);
		}
		catch (error) {
			this.hideProgress();
			this.deps.setStatus(error instanceof Error ? error.message : String(error));
		}
		finally {
			this.deps.indexSymbolsButton.disabled = false;
			this.deps.symbolDirectoryInput.value = '';
		}
	}

	protected summaryLabel(summary: SymbolLibrarySummary): string {
		const errors = summary.errorCount ? `, ${ summary.errorCount } failed` : '';
		return `Indexed ${ summary.symbolCount } symbols from ${ summary.fileCount } files${ errors }.`;
	}

	protected showProgress(): void {
		this.progressModalEl.classList.remove('hidden');
		this.progressFillEl.style.width = '0%';
		this.progressLabelEl.textContent = 'Starting…';
	}

	protected hideProgress(): void {
		this.progressModalEl.classList.add('hidden');
	}

	protected finishProgress(summary: SymbolLibrarySummary): void {
		this.hideProgress();
		const label = this.summaryLabel(summary);
		this.deps.setStatus(label);
		this.deps.indexSymbolsButton.title = `${ label } Click to rescan.`;
		console.log(`[symbol-library] ${ label }`);
	}

	/** Real KiCad shows a modeless progress dialog for a real-file directory
	 *  scan (mirrors the zone-fill progress modal here) — a symbol library
	 *  folder can be thousands of files, and the per-file text used to only
	 *  flash through the status bar too fast to read. Per-file failures are
	 *  logged to the console (not the status bar, which the next progress
	 *  update immediately overwrites) so they're actually inspectable after
	 *  the fact, alongside the final aggregate count/failure summary. */
	protected reportProgress(progress: SymbolLibraryProgress): void {
		const total = progress.totalFiles ?? 0;
		this.progressFillEl.style.width = `${ total > 0 ? (progress.processedFiles / total) * 100 : 0 }%`;
		this.progressLabelEl.textContent = total
			? `${ progress.processedFiles } / ${ total } — ${ progress.fileName }`
			: `${ progress.processedFiles } — ${ progress.fileName }`;
		if (progress.error) {
			console.warn(`[symbol-library] Failed to index "${ progress.fileName }": ${ progress.error }`);
		}
	}
}
