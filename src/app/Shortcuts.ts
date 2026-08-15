export type ShortcutActionId =
	| 'undo' | 'redo' | 'save' | 'cut' | 'copy' | 'paste' | 'duplicate' | 'zoom-fit' | 'move' | 'rotate' | 'tidy'
	| 'select' | 'place-symbol' | 'power' | 'wire' | 'bus' | 'bus-entry' | 'no-connect' | 'junction'
	| 'label' | 'directive-label' | 'global-label' | 'hier-label' | 'rule-area'
	| 'text' | 'text-box' | 'table' | 'line' | 'rect' | 'circle' | 'arc' | 'bezier' | 'image' | 'delete';

export interface ShortcutAction {
	id: ShortcutActionId;
	category: 'Common' | 'Schematic Editor';
	label: string;
	defaultBinding: string;
}

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
	{ id: 'undo', category: 'Common', label: 'Undo', defaultBinding: 'Ctrl+Z' },
	{ id: 'redo', category: 'Common', label: 'Redo', defaultBinding: 'Ctrl+Shift+Z' },
	{ id: 'save', category: 'Common', label: 'Save Project', defaultBinding: 'Ctrl+S' },
	{ id: 'cut', category: 'Common', label: 'Cut', defaultBinding: 'Ctrl+X' },
	{ id: 'copy', category: 'Common', label: 'Copy', defaultBinding: 'Ctrl+C' },
	{ id: 'paste', category: 'Common', label: 'Paste', defaultBinding: 'Ctrl+V' },
	{ id: 'duplicate', category: 'Common', label: 'Duplicate', defaultBinding: 'Ctrl+D' },
	{ id: 'zoom-fit', category: 'Common', label: 'Zoom to Fit', defaultBinding: 'Home' },
	{ id: 'move', category: 'Common', label: 'Move Selected Items', defaultBinding: 'M' },
	{ id: 'rotate', category: 'Schematic Editor', label: 'Rotate Selected', defaultBinding: 'R' },
	{ id: 'tidy', category: 'Schematic Editor', label: 'Autoplace Selected Fields', defaultBinding: 'T' },
	{ id: 'select', category: 'Schematic Editor', label: 'Select Tool', defaultBinding: 'S' },
	{ id: 'place-symbol', category: 'Schematic Editor', label: 'Place Symbol', defaultBinding: 'A' },
	{ id: 'power', category: 'Schematic Editor', label: 'Place Power Port', defaultBinding: 'P' },
	{ id: 'wire', category: 'Schematic Editor', label: 'Place Wire', defaultBinding: 'W' },
	{ id: 'bus', category: 'Schematic Editor', label: 'Place Bus', defaultBinding: 'U' },
	{ id: 'bus-entry', category: 'Schematic Editor', label: 'Place Wire to Bus Entry', defaultBinding: 'I' },
	{ id: 'no-connect', category: 'Schematic Editor', label: 'Place No Connect', defaultBinding: 'X' },
	{ id: 'junction', category: 'Schematic Editor', label: 'Place Junction', defaultBinding: 'J' },
	{ id: 'label', category: 'Schematic Editor', label: 'Place Local Label', defaultBinding: 'N' },
	{ id: 'directive-label', category: 'Schematic Editor', label: 'Place Directive Label', defaultBinding: 'Ctrl+L' },
	{ id: 'global-label', category: 'Schematic Editor', label: 'Place Global Label', defaultBinding: 'G' },
	{ id: 'hier-label', category: 'Schematic Editor', label: 'Place Hierarchical Label', defaultBinding: 'H' },
	{ id: 'rule-area', category: 'Schematic Editor', label: 'Place Rule Area', defaultBinding: 'Shift+R' },
	{ id: 'text', category: 'Schematic Editor', label: 'Place Text', defaultBinding: 'Ctrl+T' },
	{ id: 'text-box', category: 'Schematic Editor', label: 'Place Text Box', defaultBinding: 'Shift+T' },
	{ id: 'table', category: 'Schematic Editor', label: 'Place Table', defaultBinding: 'Ctrl+Shift+T' },
	{ id: 'line', category: 'Schematic Editor', label: 'Place Line', defaultBinding: 'L' },
	{ id: 'rect', category: 'Schematic Editor', label: 'Place Rectangle', defaultBinding: 'Shift+M' },
	{ id: 'circle', category: 'Schematic Editor', label: 'Place Circle', defaultBinding: 'C' },
	{ id: 'arc', category: 'Schematic Editor', label: 'Place Arc', defaultBinding: 'Shift+A' },
	{ id: 'bezier', category: 'Schematic Editor', label: 'Place Bezier Curve', defaultBinding: 'Shift+B' },
	{ id: 'image', category: 'Schematic Editor', label: 'Place Image', defaultBinding: 'Ctrl+I' },
	{ id: 'delete', category: 'Schematic Editor', label: 'Delete Selected Items', defaultBinding: 'Delete' }
];

export type ShortcutMap = Record<ShortcutActionId, string>;

export function defaultShortcuts(): ShortcutMap {
	return Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, action.defaultBinding])) as ShortcutMap;
}

export function normalizeShortcutEvent(event: KeyboardEvent): string | null {
	if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
		return null;
	}
	const key = event.key.length === 1 ? event.key.toUpperCase() : event.key === ' ' ? 'Space' : event.key;
	return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key]
		.filter(Boolean).join('+');
}

export function shortcutMatches(event: KeyboardEvent, binding: string): boolean {
	return !!binding && normalizeShortcutEvent(event) === binding;
}
