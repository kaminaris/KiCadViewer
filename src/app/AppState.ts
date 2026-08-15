import type { KicadRenderSession } from '@kicad-render/KicadRenderSession';
import type { ActiveDocument }     from './ActiveDocument';

export type AppMode = 'view' | 'circuit' | 'edit';

/** Cross-cutting app state — today just the cached schematic/board text, kept
 *  as its own class (not inlined into ActiveDocument) because it's injected
 *  directly into several other classes' constructors (SessionController,
 *  ClipboardController, TextInputFlow) rather than reached via a closure.
 *  Also the one choke point every one of those mutation call sites already
 *  funnels through after an edit — see textCommitHandler, which
 *  SessionController uses to hook Phase 5's ProjectStore in without
 *  touching every individual call site. */
export class AppState {
	protected textCommitHandler: ((text: string) => void) | null = null;
	protected textChangedHandler: (() => void) | null = null;

	constructor(protected readonly doc: ActiveDocument) {}

	/** SessionController calls this once to route every committed edit
	 *  (see refreshSchematicText) to whichever ProjectStore backs the
	 *  currently open project — re-set whenever that project changes.
	 *  Deliberately a plain callback, not a Set of listeners: there is only
	 *  ever one project open per page, so there is only ever one
	 *  destination for this. */
	setTextCommitHandler(handler: ((text: string) => void) | null): void {
		this.textCommitHandler = handler;
	}

	setTextChangedHandler(handler: (() => void) | null): void {
		this.textChangedHandler = handler;
	}

	/** Refresh from the live session (preferring it), falling back to the
	 *  last-known-good cached copy when the session transiently can't
	 *  produce one (no schematic loaded / mid-load — see
	 *  KicadRenderSession.getSchematicText's own contract: it returns ''
	 *  whenever documentType isn't 'schematic' or the AST root is absent).
	 *  Returns the result so call sites that need it immediately don't need
	 *  a separate read. */
	refreshSchematicText(session: KicadRenderSession | null | undefined): string {
		this.doc.schematicText = session?.getSchematicText() || this.doc.schematicText;
		this.textCommitHandler?.(this.doc.schematicText);
		this.textChangedHandler?.();
		return this.doc.schematicText;
	}

	get schematicText(): string {
		return this.doc.schematicText;
	}

	/** For call sites priming the cache with text they already computed
	 *  fresh (a just-loaded file, a just-computed reroute/place result)
	 *  rather than deriving it from the session. */
	setSchematicText(text: string): void {
		this.doc.schematicText = text;
		this.textChangedHandler?.();
	}

	/** Board-side counterpart to refreshSchematicText — same choke point,
	 *  same textCommitHandler (SessionController's handler branches on
	 *  doc.kind internally to route to the right save target). */
	refreshBoardText(session: KicadRenderSession | null | undefined): string {
		this.doc.boardText = session?.getBoardText() || this.doc.boardText;
		this.textCommitHandler?.(this.doc.boardText);
		this.textChangedHandler?.();
		return this.doc.boardText;
	}

	get boardText(): string {
		return this.doc.boardText;
	}

	/** For call sites priming the cache with text they already computed
	 *  fresh, mirroring setSchematicText. */
	setBoardText(text: string): void {
		this.doc.boardText = text;
		this.textChangedHandler?.();
	}

	get hasUnsavedSchematicChanges(): boolean {
		return this.doc.hasUnsavedSchematicChanges;
	}

	get hasUnsavedBoardChanges(): boolean {
		return this.doc.hasUnsavedBoardChanges;
	}

	markSchematicSaved(): void {
		this.doc.savedSchematicText = this.doc.schematicText;
		this.textChangedHandler?.();
	}

	markBoardSaved(): void {
		this.doc.savedBoardText = this.doc.boardText;
		this.textChangedHandler?.();
	}
}
