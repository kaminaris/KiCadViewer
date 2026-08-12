import type { KicadProject } from '@kicad-io/Project/KicadProject';
import type { PathUtils }    from '@kicad-io/Project/PathUtils';

/** The subset of BrowserFsAdapter/IndexedDbFsAdapter that KicadProject
 *  actually needs — a structural interface rather than a union of the two
 *  concrete classes, so ProjectContext doesn't need to know which backend
 *  is behind it (folder vs. imported-into-IndexedDB). */
export interface ProjectFsAdapter {
	loadFile(path: string): Promise<string>;

	saveFile(path: string, content: string): Promise<void>;

	pathUtils: PathUtils;
}

/** A whole open project (root schematic + hierarchy + board + .kicad_pro) —
 *  single-owner (this page's one ActiveDocument) for now. `key` (a stable
 *  id derived from the folder/imported-project identity — see
 *  SessionController's openProjectFolder/openProjectZip) is the join-key
 *  the cross-tab sync layer (ProjectStore/SyncedProjectStore) uses to
 *  recognize "same project opened in a different browser tab" — see the
 *  harmonic-munching-trinket plan. */
export class ProjectContext {
	constructor(
		public readonly key: string,
		public readonly project: KicadProject,
		public readonly fsAdapter: ProjectFsAdapter | null,
		public readonly rootName: string
	) {}

	get readOnly(): boolean { return !this.fsAdapter; }
}
