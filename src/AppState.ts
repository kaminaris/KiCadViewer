import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';

export type AppMode = 'view' | 'circuit' | 'edit';

/**
 * Growing home for cross-cutting application state as main.ts's split into
 * per-concern files proceeds — starts scoped to just the schematic-text
 * cache (by far the most-duplicated piece of state in the old monolith);
 * `mode`/`session`/`editTool`/selection bookkeeping/circuit-mode fields
 * move in as their owning subsystems (SessionController, GestureController,
 * ContextMenu, PropertyPanel) are extracted in later steps, rather than
 * being renamed here ahead of any real consumer.
 */
export class AppState {
	protected _schematicText = '';

	/** Refresh from the live session (preferring it), falling back to the
	 *  last-known-good cached copy when the session transiently can't
	 *  produce one (no schematic loaded / mid-load — see
	 *  KicadRenderSession.getSchematicText's own contract: it returns ''
	 *  whenever documentType isn't 'schematic' or the AST root is absent).
	 *  Returns the result so call sites that need it immediately don't need
	 *  a separate read. */
	refreshSchematicText(session: KicadRenderSession | null | undefined): string {
		this._schematicText = session?.getSchematicText() || this._schematicText;
		return this._schematicText;
	}

	get schematicText(): string {
		return this._schematicText;
	}

	/** For call sites priming the cache with text they already computed
	 *  fresh (a just-loaded file, a just-computed reroute/place result)
	 *  rather than deriving it from the session. */
	setSchematicText(text: string): void {
		this._schematicText = text;
	}
}
