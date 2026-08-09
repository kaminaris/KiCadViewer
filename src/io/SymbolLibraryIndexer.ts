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
			const summary = await this.cache.indexDirectory(directory, progress => this.reportProgress(progress));
			this.deps.setStatus(this.summaryLabel(summary));
			this.deps.indexSymbolsButton.title = `${ this.summaryLabel(summary) } Click to rescan.`;
		}
		catch (error) {
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
		try {
			const firstPath = (files[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
			const rootName = firstPath?.split('/')[0] || 'Selected symbols directory';
			const summary = await this.cache.indexFiles(files, rootName, progress => this.reportProgress(progress));
			this.deps.setStatus(this.summaryLabel(summary));
			this.deps.indexSymbolsButton.title = `${ this.summaryLabel(summary) } Click to rescan.`;
		}
		catch (error) {
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

	protected reportProgress(progress: SymbolLibraryProgress): void {
		const total = progress.totalFiles ? `/${ progress.totalFiles }` : '';
		const suffix = progress.error ? ` — ${ progress.error }` : ` — ${ progress.symbolCount } symbols`;
		this.deps.setStatus(`Indexing symbols ${ progress.processedFiles }${ total }: ${ progress.fileName }${ suffix }`);
	}
}
