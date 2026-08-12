import {
	basenameGeneric, dirnameGeneric, extnameGeneric, isAbsoluteGeneric, joinPathGeneric, resolvePathGeneric
}                         from '@kicad-render/PathUtils';
import type { PathUtils } from '@kicad-io/Project/PathUtils';
import { ZipArchive }     from './ZipArchive';

/**
 * Implements kicad-io's `loadFile`/`PathUtils` contract against an
 * already-opened ZipArchive — the read-only counterpart to
 * BrowserFsAdapter's directory-handle version. No `saveFile`: writing back
 * into an uploaded zip isn't part of "load zip... extract" (would mean
 * building a NEW zip and offering it as a download, a separate feature);
 * Save Project simply stays unavailable for a zip-opened project.
 *
 * Unlike BrowserFsAdapter (which had to invent a "bare filename = archive
 * root" convention since a FileSystemDirectoryHandle has no path string of
 * its own), a zip archive's entries ARE already full path strings relative
 * to the archive root — loadFile can hand paths straight to
 * ZipArchive.readText() with no segment traversal/resolution at all.
 */
export class ZipFsAdapter {
	constructor(protected readonly archive: ZipArchive) {}

	readonly pathUtils: PathUtils = {
		dirname: dirnameGeneric,
		resolve: (...paths: string[]) => resolvePathGeneric(...paths),
		join: (...paths: string[]) => paths.reduce((acc, p) => (acc ? joinPathGeneric(acc, p) : p), ''),
		basename: (filePath: string, ext?: string) => {
			const base = basenameGeneric(filePath);
			return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
		},
		extname: extnameGeneric,
		isAbsolute: isAbsoluteGeneric
	};

	loadFile = (filePath: string): Promise<string> => this.archive.readText(filePath);

	/** Finds a `.kicad_pro` anywhere in the archive — unlike
	 *  BrowserFsAdapter.findProjectFile() (which only looks at the picked
	 *  folder's own top level), a zip's internal layout is unknown ahead of
	 *  time: some tools wrap the project in a folder entry
	 *  ("MyProject/MyProject.kicad_pro"), others zip the folder's contents
	 *  directly ("MyProject.kicad_pro" at the archive root). Prefers the
	 *  shallowest match if more than one is present (e.g. a zip that
	 *  happens to contain a nested/example sub-project too). */
	findProjectFile(): string | null {
		const matches = this.archive.listEntries().filter(name => name.toLowerCase().endsWith('.kicad_pro'));
		if (!matches.length) {
			return null;
		}
		matches.sort((a, b) => a.split('/').length - b.split('/').length);
		return matches[0]!;
	}
}
