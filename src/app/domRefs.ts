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
	lockedNetsEl: HTMLElement;
	stage: HTMLElement;
	canvas: HTMLCanvasElement;
	canvasGl: HTMLCanvasElement;
	modeViewBtn: HTMLElement;
	modeCircuitBtn: HTMLElement;
	modeEditBtn: HTMLElement;
	viewActions: HTMLElement;
	circuitActions: HTMLElement;
	editActions: HTMLElement;
	indexSymbolsButton: HTMLButtonElement;
	symbolDirectoryInput: HTMLInputElement;
	editLeftPane: HTMLElement;
	editPropertiesEl: HTMLElement;
	editHierarchyEl: HTMLElement;
	toolPanel: HTMLElement;
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
	newProjectButton: HTMLButtonElement;
	projectHierarchySection: HTMLElement;
	projectHierarchyEl: HTMLElement;
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
	propertiesModalCloseButton: HTMLElement | null;
	paneSplitters: HTMLElement[];

	getToolGroupButton(id: string): HTMLButtonElement | null;
}

export function createMainDomRefs(): MainDomRefs {
	return {
		lockedNetsEl: requiredById<HTMLElement>('locked-nets'),
		stage: requiredById<HTMLElement>('stage'),
		canvas: requiredById<HTMLCanvasElement>('canvas2d'),
		canvasGl: requiredById<HTMLCanvasElement>('canvas-gl'),
		modeViewBtn: requiredById<HTMLElement>('mode-view'),
		modeCircuitBtn: requiredById<HTMLElement>('mode-circuit'),
		modeEditBtn: requiredById<HTMLElement>('mode-edit'),
		viewActions: requiredById<HTMLElement>('view-actions'),
		circuitActions: requiredById<HTMLElement>('circuit-actions'),
		editActions: requiredById<HTMLElement>('edit-actions'),
		indexSymbolsButton: requiredById<HTMLButtonElement>('btn-index-symbols'),
		symbolDirectoryInput: requiredById<HTMLInputElement>('symbol-directory-input'),
		editLeftPane: requiredById<HTMLElement>('edit-left-pane'),
		editPropertiesEl: requiredById<HTMLElement>('edit-properties'),
		editHierarchyEl: requiredById<HTMLElement>('edit-hierarchy'),
		toolPanel: requiredById<HTMLElement>('tool-panel'),
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
		newProjectButton: requiredById<HTMLButtonElement>('btn-new-project'),
		projectHierarchySection: requiredById<HTMLElement>('project-hierarchy-section'),
		projectHierarchyEl: requiredById<HTMLElement>('project-hierarchy'),
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
		propertiesModalCloseButton: optionalById<HTMLElement>('properties-modal-close'),
		paneSplitters: Array.from(document.querySelectorAll<HTMLElement>('.pane-splitter')),
		getToolGroupButton: id => optionalById<HTMLButtonElement>(id)
	};
}
