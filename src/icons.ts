/**
 * Inline `<path>`/`<rect>`/`<circle>` markup (not full `<svg>` wrappers) for
 * icons swapped at runtime via `svg.innerHTML` — see Toolbar's power-tool and
 * tool-group icon sync. Always target the `<svg class="tool-icon">` inside a
 * button, never the button itself: writing to `button.innerHTML` destroys the
 * button's own `<svg>` wrapper, not just the glyph.
 *
 * The 17 static, never-swapped toolbar icons live as literal markup in
 * index.html and stay there — moving those here would be pure churn.
 */

export const POWER_KIND_ICONS: Record<'gnd' | 'flag' | 'rail', string> = {
	gnd: '<path d="M12 4 V10"/><path d="M7 10 H17 M8.5 13 H15.5 M10.5 16 H13.5"/>',
	flag: '<path d="M12 18 V12"/><path d="M8 12 L12 8 L16 12 L12 16 Z"/>',
	rail: '<path d="M12 18 V6 M7 11 L12 6 L17 11"/>'
};

export type LabelToolKind = 'label' | 'directive-label' | 'global-label' | 'hier-label';
export const LABEL_TOOL_ICONS: Record<LabelToolKind, string> = {
	'label': '<path d="M4 8 H15 L19 12 L15 16 H4 Z"/>',
	'directive-label': '<path d="M9 4 H15 L19 12 L15 20 H9 L5 12 Z"/>',
	'global-label': '<path d="M4 12 L7 8 H17 L20 12 L17 16 H7 Z"/>',
	'hier-label': '<path d="M4 8 L7 12 L4 16 H14 L20 12 L14 8 Z"/>'
};

export type ShapeToolKind = 'line' | 'rect' | 'circle' | 'arc' | 'bezier';
export const SHAPE_TOOL_ICONS: Record<ShapeToolKind, string> = {
	line: '<path d="M4 18 L20 6"/>',
	rect: '<rect x="5" y="6" width="14" height="12"/>',
	circle: '<circle cx="12" cy="12" r="7"/>',
	arc: '<path d="M5 16 A10 10 0 0 1 19 10"/>',
	bezier: '<path d="M4 18 C 8 6, 16 18, 20 6"/>'
};
