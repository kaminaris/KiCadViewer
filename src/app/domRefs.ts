function requiredById<T extends HTMLElement>(id: string): T {
	const element = document.getElementById(id) as T | null;
	if (!element) {
		throw new Error(`Missing required DOM element: #${ id }`);
	}
	return element;
}

function optionalById<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

function requiredSelector<T extends Element>(selector: string): T {
	const element = document.querySelector(selector) as T | null;
	if (!element) {
		throw new Error(`Missing required DOM element: ${ selector }`);
	}
	return element;
}

export interface MainDomRefs {
	screenHomeEl: HTMLElement;
	screenProjectEl: HTMLElement;
	screenEditorEl: HTMLElement;
	brandHomeButton: HTMLButtonElement;
	stage: HTMLElement;
	canvas: HTMLCanvasElement;
	canvasGl: HTMLCanvasElement;
	/** Hidden, non-interactive now — setMode() still toggles their .active
	 *  class / .disabled state internally (kept so PointerController/
	 *  ContextMenuController/KeyboardController's existing mode-gated logic
	 *  needs no changes), but nothing in the visible UI reaches them
	 *  anymore. See breadcrumbEl/viewTabsEl for what replaced them. */
	modeViewBtn: HTMLElement;
	modeCircuitBtn: HTMLElement;
	modeEditBtn: HTMLElement;
	viewActions: HTMLElement;
	circuitActions: HTMLElement;
	editActions: HTMLElement;
	breadcrumbEl: HTMLElement;
	breadcrumbProjectEl: HTMLElement;
	breadcrumbSheetEl: HTMLElement;
	viewTabsEl: HTMLElement;
	viewTabSchematicBtn: HTMLButtonElement;
	viewTabBoardBtn: HTMLButtonElement;
	viewTabProjectSettingsBtn: HTMLButtonElement;
	projectSetupWorkspaceEl: HTMLElement;
	indexSymbolsButton: HTMLButtonElement;
	indexFootprintsButton: HTMLButtonElement;
	symbolDirectoryInput: HTMLInputElement;
	footprintDirectoryInput: HTMLInputElement;
	editPropertiesEl: HTMLElement;
	editUndoStackEl: HTMLElement;
	editLibrariesPaneEl: HTMLElement;
	editLibrariesEl: HTMLElement;
	editHierarchyPaneEl: HTMLElement;
	editHierarchyEl: HTMLElement;
	toolPanel: HTMLElement;
	schematicTogglePanel: HTMLElement;
	boardTogglePanel: HTMLElement;
	boardToolPanel: HTMLElement;
	boardAppearanceEl: HTMLElement;
	symbolToolPanel: HTMLElement;
	symbolActionsEl: HTMLElement;
	symbolSaveButton: HTMLButtonElement;
	symbolRevertButton: HTMLButtonElement;
	symbolStageCanvas: HTMLCanvasElement;
	symbolTextInput: HTMLInputElement;
	symbolMirrorHButton: HTMLButtonElement;
	symbolMirrorVButton: HTMLButtonElement;
	symbolRotateCcwButton: HTMLButtonElement;
	symbolRotateCwButton: HTMLButtonElement;
	symbolPinTableButton: HTMLButtonElement;
	symbolPropertiesButton: HTMLButtonElement;
	symbolUnitSelect: HTMLSelectElement;
	highlightNetButton: HTMLButtonElement;
	mainEl: HTMLElement;
	editTextInput: HTMLInputElement;
	editTextBoxInput: HTMLTextAreaElement;
	tableModal: HTMLDivElement;
	tableRowsInput: HTMLInputElement;
	tableColumnsInput: HTMLInputElement;
	tableDataInput: HTMLTextAreaElement;
	imageInput: HTMLInputElement;
	propertiesModalEl: HTMLDivElement;
	contextMenuEl: HTMLDivElement;
	gridSelectEl: HTMLSelectElement;
	powerToolButton: HTMLButtonElement;
	fileInput: HTMLInputElement;
	circuitFileInput: HTMLInputElement;
	openProjectButton: HTMLButtonElement;
	saveProjectButton: HTMLButtonElement;
	exportProjectZipButton: HTMLButtonElement;
	newProjectButton: HTMLButtonElement;
	zipInput: HTMLInputElement;
	demoButton: HTMLButtonElement;
	recipeInput: HTMLInputElement;
	symbolInput: HTMLInputElement;
	placeButton: HTMLButtonElement;
	autowireButton: HTMLButtonElement;
	clearWiresButton: HTMLButtonElement;
	exportButton: HTMLButtonElement;
	exportEditButton: HTMLButtonElement;
	undoButton: HTMLButtonElement;
	redoButton: HTMLButtonElement;
	preferencesButton: HTMLButtonElement;
	symbolFieldsTableButton: HTMLButtonElement;
	annotateSchematicButton: HTMLButtonElement;
	updatePcbFromSchematicButton: HTMLButtonElement;
	routerSettingsButton: HTMLButtonElement;
	propertiesModalCloseButton: HTMLElement | null;
	paneSplitters: HTMLElement[];

	getToolGroupButton(id: string): HTMLButtonElement | null;
}

export function createMainDomRefs(): MainDomRefs {
	return {
		screenHomeEl: requiredById<HTMLElement>('screen-home'),
		screenProjectEl: requiredById<HTMLElement>('screen-project'),
		screenEditorEl: requiredById<HTMLElement>('screen-editor'),
		brandHomeButton: requiredById<HTMLButtonElement>('brand-home-btn'),
		stage: requiredById<HTMLElement>('stage'),
		canvas: requiredById<HTMLCanvasElement>('canvas2d'),
		canvasGl: requiredById<HTMLCanvasElement>('canvas-gl'),
		modeViewBtn: requiredById<HTMLElement>('mode-view'),
		modeCircuitBtn: requiredById<HTMLElement>('mode-circuit'),
		modeEditBtn: requiredById<HTMLElement>('mode-edit'),
		viewActions: requiredById<HTMLElement>('view-actions'),
		circuitActions: requiredById<HTMLElement>('circuit-actions'),
		editActions: requiredById<HTMLElement>('edit-actions'),
		breadcrumbEl: requiredById<HTMLElement>('editor-breadcrumb'),
		breadcrumbProjectEl: requiredById<HTMLElement>('breadcrumb-project'),
		breadcrumbSheetEl: requiredById<HTMLElement>('breadcrumb-sheet'),
		viewTabsEl: requiredById<HTMLElement>('view-tabs'),
		viewTabSchematicBtn: requiredById<HTMLButtonElement>('view-tab-schematic'),
		viewTabBoardBtn: requiredById<HTMLButtonElement>('view-tab-board'),
		viewTabProjectSettingsBtn: requiredById<HTMLButtonElement>('view-tab-project-settings'),
		projectSetupWorkspaceEl: requiredById<HTMLElement>('project-setup-workspace'),
		indexSymbolsButton: requiredById<HTMLButtonElement>('btn-index-symbols'),
		indexFootprintsButton: requiredById<HTMLButtonElement>('btn-index-footprints'),
		symbolDirectoryInput: requiredById<HTMLInputElement>('symbol-directory-input'),
		footprintDirectoryInput: requiredById<HTMLInputElement>('footprint-directory-input'),
		editPropertiesEl: requiredById<HTMLElement>('edit-properties'),
		editUndoStackEl: requiredById<HTMLElement>('edit-undo-stack'),
		editLibrariesPaneEl: requiredById<HTMLElement>('edit-libraries-pane'),
		editLibrariesEl: requiredById<HTMLElement>('edit-libraries'),
		editHierarchyPaneEl: requiredById<HTMLElement>('edit-hierarchy-pane'),
		editHierarchyEl: requiredById<HTMLElement>('edit-hierarchy'),
		toolPanel: requiredById<HTMLElement>('tool-panel'),
		schematicTogglePanel: requiredById<HTMLElement>('schematic-toggle-panel'),
		boardTogglePanel: requiredById<HTMLElement>('board-toggle-panel'),
		boardToolPanel: requiredById<HTMLElement>('board-tool-panel'),
		boardAppearanceEl: requiredById<HTMLElement>('board-appearance'),
		symbolToolPanel: requiredById<HTMLElement>('symbol-tool-panel'),
		symbolActionsEl: requiredById<HTMLElement>('symbol-actions'),
		symbolSaveButton: requiredById<HTMLButtonElement>('btn-symbol-save'),
		symbolRevertButton: requiredById<HTMLButtonElement>('btn-symbol-revert'),
		symbolStageCanvas: requiredById<HTMLCanvasElement>('symbol-stage-canvas'),
		symbolTextInput: requiredById<HTMLInputElement>('symbol-text-input'),
		symbolMirrorHButton: requiredById<HTMLButtonElement>('btn-symbol-mirror-h'),
		symbolMirrorVButton: requiredById<HTMLButtonElement>('btn-symbol-mirror-v'),
		symbolRotateCcwButton: requiredById<HTMLButtonElement>('btn-symbol-rotate-ccw'),
		symbolRotateCwButton: requiredById<HTMLButtonElement>('btn-symbol-rotate-cw'),
		symbolPinTableButton: requiredById<HTMLButtonElement>('btn-symbol-pin-table'),
		symbolPropertiesButton: requiredById<HTMLButtonElement>('btn-symbol-properties'),
		symbolUnitSelect: requiredById<HTMLSelectElement>('symbol-unit-select'),
		highlightNetButton: requiredById<HTMLButtonElement>('btn-highlight-net'),
		mainEl: requiredSelector<HTMLElement>('main'),
		editTextInput: requiredById<HTMLInputElement>('edit-text-input'),
		editTextBoxInput: requiredById<HTMLTextAreaElement>('edit-text-box-input'),
		tableModal: requiredById<HTMLDivElement>('table-modal'),
		tableRowsInput: requiredById<HTMLInputElement>('table-rows'),
		tableColumnsInput: requiredById<HTMLInputElement>('table-columns'),
		tableDataInput: requiredById<HTMLTextAreaElement>('table-data'),
		imageInput: requiredById<HTMLInputElement>('image-input'),
		propertiesModalEl: requiredById<HTMLDivElement>('properties-modal'),
		contextMenuEl: requiredById<HTMLDivElement>('context-menu'),
		gridSelectEl: requiredById<HTMLSelectElement>('grid-select'),
		powerToolButton: requiredById<HTMLButtonElement>('btn-power-tool'),
		fileInput: requiredById<HTMLInputElement>('file-input'),
		circuitFileInput: requiredById<HTMLInputElement>('circuit-file-input'),
		openProjectButton: requiredById<HTMLButtonElement>('btn-open-project'),
		saveProjectButton: requiredById<HTMLButtonElement>('btn-save-project'),
		exportProjectZipButton: requiredById<HTMLButtonElement>('btn-export-project-zip'),
		newProjectButton: requiredById<HTMLButtonElement>('btn-new-project'),
		zipInput: requiredById<HTMLInputElement>('zip-input'),
		demoButton: requiredById<HTMLButtonElement>('btn-demo'),
		recipeInput: requiredById<HTMLInputElement>('recipe-input'),
		symbolInput: requiredById<HTMLInputElement>('symbol-input'),
		placeButton: requiredById<HTMLButtonElement>('btn-place'),
		autowireButton: requiredById<HTMLButtonElement>('btn-autowire'),
		clearWiresButton: requiredById<HTMLButtonElement>('btn-clear-wires'),
		exportButton: requiredById<HTMLButtonElement>('btn-export'),
		exportEditButton: requiredById<HTMLButtonElement>('btn-export-edit'),
		undoButton: requiredById<HTMLButtonElement>('btn-undo'),
		redoButton: requiredById<HTMLButtonElement>('btn-redo'),
		preferencesButton: requiredById<HTMLButtonElement>('btn-preferences'),
		symbolFieldsTableButton: requiredById<HTMLButtonElement>('btn-symbol-fields-table'),
		annotateSchematicButton: requiredById<HTMLButtonElement>('btn-annotate-schematic'),
		updatePcbFromSchematicButton: requiredById<HTMLButtonElement>('btn-update-pcb-from-schematic'),
		routerSettingsButton: requiredById<HTMLButtonElement>('btn-router-settings'),
		propertiesModalCloseButton: optionalById<HTMLElement>('properties-modal-close'),
		paneSplitters: Array.from(document.querySelectorAll<HTMLElement>('.pane-splitter')),
		getToolGroupButton: id => optionalById<HTMLButtonElement>(id)
	};
}
