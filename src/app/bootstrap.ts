import type { Settings }    from './Settings';
import type { MainDomRefs } from './domRefs';
import type { AppMode }     from './AppState';

export interface MainBootstrapOptions {
	dom: MainDomRefs;
	settings: Settings;

	setMode(mode: AppMode): void;

	ensureSession(): void;

	resizeCanvas(): void;

	refreshSymbolLibraryButton(): Promise<void>;

	refreshFootprintLibraryButton(): Promise<void>;

	updateStatusBar(): void;
}

/** Runs one-time app startup setup after listeners/controllers are wired. */
export function runMainBootstrap(options: MainBootstrapOptions): void {
	options.dom.gridSelectEl.value = String(options.settings.gridSpacingFor('schematic'));
	options.setMode('view');
	options.ensureSession();
	options.resizeCanvas();
	void options.refreshSymbolLibraryButton();
	void options.refreshFootprintLibraryButton();
	options.updateStatusBar();
}
