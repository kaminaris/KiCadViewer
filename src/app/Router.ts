import type { DocumentKind } from './ActiveDocument';

export type EditorView = DocumentKind | 'project-settings';

export interface RouteHome {
	screen: 'home';
}

export interface RouteProject {
	screen: 'project';
	projectId: string;
}

export interface RouteEditor {
	screen: 'editor';
	/** null = "scratch" editor — a single loose file opened with no project
	 *  behind it (the pre-project-support `Open .kicad_sch / .kicad_pcb`
	 *  entry point), reached from Home's "Open a single file" action so it
	 *  stays usable without inventing a registry entry for it. Also how a
	 *  loose symbol library file (view === 'symbol') is opened outside a
	 *  project. */
	projectId: string | null;
	view: EditorView;
	sheet: string | null;
	category?: string | null;
	/** Which `.kicad_sym` library file is open when `view === 'symbol'` —
	 *  the symbol-editor analog of `sheet`. Unused for every other view. */
	symbolFileId?: string | null;
}

export type Route = RouteHome | RouteProject | RouteEditor;

function parseRoute(search: string): Route {
	const params = new URLSearchParams(search);
	const projectId = params.get('project');
	const view = params.get('view');
	if (view === 'symbol') {
		return {
			screen: 'editor', projectId: projectId ?? null, view: 'symbol', sheet: null,
			symbolFileId: params.get('symbol') ?? null
		};
	}
	if (!projectId) {
		if (view === 'schematic' || view === 'board') {
			return { screen: 'editor', projectId: null, view, sheet: null };
		}
		return { screen: 'home' };
	}
	if (view !== 'schematic' && view !== 'board' && view !== 'project-settings') {
		return { screen: 'project', projectId };
	}
	const category = view === 'project-settings' ? params.get('category') : null;
	return { screen: 'editor', projectId, view, sheet: params.get('sheet'), category };
}

function routeToUrl(route: Route): string {
	if (route.screen === 'home') {
		return window.location.pathname;
	}
	const params = new URLSearchParams();
	if (route.screen === 'project' || route.projectId !== null) {
		params.set('project', route.projectId as string);
	}
	if (route.screen === 'editor') {
		params.set('view', route.view);
		if (route.view === 'project-settings' && route.category) {
			params.set('category', route.category);
		}
		if (route.view === 'symbol') {
			if (route.symbolFileId) {
				params.set('symbol', route.symbolFileId);
			}
		}
		else if (route.sheet) {
			params.set('sheet', route.sheet);
		}
	}
	return `${ window.location.pathname }?${ params.toString() }`;
}

/**
 * No framework — parses `location.search` into one of three screens (home /
 * project / editor) and drives `history.pushState`/`popstate`. This is the
 * unit MainApp.ts hangs SessionController calls and screen visibility off
 * of; see the harmonic-munching-trinket plan's Phase 2. `view` reuses
 * ActiveDocument's own DocumentKind ('schematic' | 'board' | 'symbol')
 * rather than inventing separate URL vocabulary (e.g. 'pcb') for the same
 * concept. The symbol editor used to be a fourth, disjoint `RouteSymbolEditor`
 * screen routed to a separate `#screen-symbol` container — folded into
 * `RouteEditor` (view: 'symbol') once the symbol editor started sharing
 * `#screen-editor`'s chrome like PCB already does (see the harmonic-
 * munching-trinket plan's "Real Symbol Editor" write-up).
 */
export class Router {
	protected current: Route;
	protected readonly handlers = new Set<(route: Route) => void>();

	constructor() {
		this.current = parseRoute(window.location.search);
		window.addEventListener('popstate', () => {
			this.current = parseRoute(window.location.search);
			this.notify();
		});
	}

	get route(): Route { return this.current; }

	onChange(handler: (route: Route) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	navigate(route: Route, options?: { replace?: boolean }): void {
		this.current = route;
		const url = routeToUrl(route);
		if (options?.replace) {
			history.replaceState(null, '', url);
		}
		else {
			history.pushState(null, '', url);
		}
		this.notify();
	}

	protected notify(): void {
		for (const handler of this.handlers) {
			handler(this.current);
		}
	}
}
