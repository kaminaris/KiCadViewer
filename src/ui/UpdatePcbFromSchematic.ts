import { KicadRenderSession }                                     from '@kicad-render/KicadRenderSession';
import { KicadSchematic }                                         from '@kicad-io/Project/KicadSchematic';
import { KicadBoard }                                             from '@kicad-io/Project/KicadBoard';
import { KicadElementFootprint }                                  from '@kicad-io/KicadElementFootprint';
import { KicadElementPad }                                        from '@kicad-io/KicadElementPad';
import { KicadElementNet }                                        from '@kicad-io/KicadElementNet';
import { KicadParser }                                            from '@kicad-io/KicadParser';
import { SchematicConnectivityService, type LoadedSchematicNode } from '@kicad-layout/Connectivity';
import type { ProjectContext }                                    from '../app/ProjectContext';
import { FootprintLibraryCache }                                  from '../io/FootprintLibraryCache';
import { makeDraggableResizable }                                 from './DraggableResizable';

export interface UpdatePcbFromSchematicCallbacks {
	setStatus(message: string): void;

	getSession(): KicadRenderSession | null;

	getProjectContext(): ProjectContext | null;

	getCurrentSheetNode(): KicadSchematic | null;

	saveProject(): Promise<void>;

	refreshSidebar(): void;
}

interface UpdatePcbOptions {
	replaceFootprints: boolean;
	deleteUnusedFootprints: boolean;
	overrideLocks: boolean;
	updateFields: boolean;
	removeExtraFields: boolean;
}

type ReportSeverity = 'error' | 'warning' | 'action' | 'info';

interface ReportLine {
	severity: ReportSeverity;
	message: string;
}

/** One resolved schematic component — real symbol fields joined onto the
 *  connectivity engine's per-pin net resolution. */
interface JoinedComponent {
	ref: string;
	value: string;
	footprintFpid: string;
	fields: Record<string, string>;
	pins: { number: string; net?: string }[];
	dnp: boolean;
}

type PlannedAction =
	| { kind: 'add-net'; name: string; id: number }
	| {
	kind: 'add-footprint';
	ref: string;
	fpid: string;
	value: string;
	pins: { number: string; net: string; netId: number }[]
}
	| { kind: 'replace-footprint'; footprint: KicadElementFootprint; ref: string; fromFpid: string; toFpid: string }
	| { kind: 'delete-footprint'; footprint: KicadElementFootprint; ref: string }
	| { kind: 'update-fields'; ref: string; fields: Record<string, string>; removeFields: string[] }
	| { kind: 'set-pad-net'; ref: string; padNumber: string; netId: number; netName: string };

interface DiffResult {
	actions: PlannedAction[];
	report: ReportLine[];
}

const MANDATORY_FOOTPRINT_FIELDS = new Set(['Reference', 'Value', 'Footprint', 'Datasheet', 'Description']);

/** Ports real KiCad's BOARD_NETLIST_UPDATER (pcbnew/netlist_reader/
 *  board_netlist_updater.cpp) — reconciles the PCB's footprints/pads/nets
 *  against the schematic's symbols/pins. The hard part (deriving per-pin
 *  net names from the schematic's own wire/label connectivity, including
 *  across sheet boundaries via hierarchical/global labels) is NOT
 *  reimplemented here — it's the already-existing, already-correct
 *  SchematicConnectivityService, just wired up as a caller for the first
 *  time. See the harmonic-munching-trinket plan for the full design,
 *  including why tracks/vias are deliberately never touched (matches real
 *  KiCad — this dialog only ever calls pad.setNet(), stale copper is left
 *  for the user/DRC to fix) and why "Group footprints"/"Apply design
 *  block layouts" render permanently disabled (no schematic-group or
 *  design-block system exists anywhere in this app). */
export class UpdatePcbFromSchematic {
	protected readonly el = document.getElementById('update-pcb-modal') as HTMLDivElement;
	protected readonly closeEl = document.getElementById('upd-close') as HTMLButtonElement;
	protected readonly optReplaceEl = document.getElementById('upd-opt-replace') as HTMLInputElement;
	protected readonly optDeleteEl = document.getElementById('upd-opt-delete') as HTMLInputElement;
	protected readonly optOverrideLocksEl = document.getElementById('upd-opt-override-locks') as HTMLInputElement;
	protected readonly optUpdateFieldsEl = document.getElementById('upd-opt-update-fields') as HTMLInputElement;
	protected readonly optRemoveFieldsEl = document.getElementById('upd-opt-remove-fields') as HTMLInputElement;
	protected readonly reportEl = document.getElementById('upd-report') as HTMLDivElement;
	protected readonly filterErrorsEl = document.getElementById('upd-filter-errors') as HTMLInputElement;
	protected readonly filterWarningsEl = document.getElementById('upd-filter-warnings') as HTMLInputElement;
	protected readonly filterActionsEl = document.getElementById('upd-filter-actions') as HTMLInputElement;
	protected readonly filterInfosEl = document.getElementById('upd-filter-infos') as HTMLInputElement;
	protected readonly countErrorsEl = document.getElementById('upd-count-errors') as HTMLSpanElement;
	protected readonly countWarningsEl = document.getElementById('upd-count-warnings') as HTMLSpanElement;
	protected readonly countActionsEl = document.getElementById('upd-count-actions') as HTMLSpanElement;
	protected readonly countInfosEl = document.getElementById('upd-count-infos') as HTMLSpanElement;
	protected readonly saveBtnEl = document.getElementById('upd-save') as HTMLButtonElement;
	protected readonly applyBtnEl = document.getElementById('upd-apply') as HTMLButtonElement;
	protected readonly closeBtnEl = document.getElementById('upd-close-btn') as HTMLButtonElement;

	protected components: JoinedComponent[] = [];
	protected boardFootprints = new Map<string, KicadElementFootprint>();
	protected diff: DiffResult = { actions: [], report: [] };

	constructor(
		protected readonly cache: FootprintLibraryCache,
		protected readonly callbacks: UpdatePcbFromSchematicCallbacks
	) {
		for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick']) {
			this.el.addEventListener(eventName, event => event.stopPropagation());
		}
		this.closeEl.addEventListener('click', () => this.close());
		this.closeBtnEl.addEventListener('click', () => this.close());
		for (const el of [
			this.optReplaceEl, this.optDeleteEl, this.optOverrideLocksEl, this.optUpdateFieldsEl, this.optRemoveFieldsEl
		]) {
			el.addEventListener('change', () => this.recompute());
		}
		for (const el of [this.filterErrorsEl, this.filterWarningsEl, this.filterActionsEl, this.filterInfosEl]) {
			el.addEventListener('change', () => this.renderReport());
		}
		this.saveBtnEl.addEventListener('click', () => this.downloadReport());
		this.applyBtnEl.addEventListener('click', () => void this.performUpdate());
		makeDraggableResizable(this.el, this.el.querySelector('.sft-header')!, { minWidth: 560, minHeight: 420 });
	}

	get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

	open(): void {
		this.el.classList.remove('hidden');
		this.load();
	}

	protected close(): void {
		this.el.classList.add('hidden');
	}

	protected options(): UpdatePcbOptions {
		return {
			replaceFootprints: this.optReplaceEl.checked,
			deleteUnusedFootprints: this.optDeleteEl.checked,
			overrideLocks: this.optOverrideLocksEl.checked,
			updateFields: this.optUpdateFieldsEl.checked,
			removeExtraFields: this.optRemoveFieldsEl.checked
		};
	}

	// ---- Data loading ------------------------------------------------------

	protected load(): void {
		this.resyncCurrentDocs();
		const projectContext = this.callbacks.getProjectContext();
		const schematic = projectContext?.project.mainSchematic;
		const board = projectContext?.project.mainBoard;
		this.components = schematic ? this.collectSchematicComponents(schematic) : [];
		this.boardFootprints = board ? this.collectBoardFootprints(board) : new Map();
		this.recompute();
	}

	/** The render session only ever holds ONE document (schematic OR board)
	 *  live at a time — edits made in the currently-open one aren't written
	 *  back into its own KicadSchematic/KicadBoard.rootElement until an
	 *  explicit save. Without this, a not-yet-saved edit on whichever
	 *  document is currently open would be silently invisible here — same
	 *  gotcha SymbolFieldsTable already hit and fixed on the schematic side
	 *  (see [[kicad-viewer-project-wide-ast-staleness]]). */
	protected resyncCurrentDocs(): void {
		const session = this.callbacks.getSession();
		if (!session) {
			return;
		}
		const currentSheet = this.callbacks.getCurrentSheetNode();
		const schematicText = session.getSchematicText();
		if (currentSheet && schematicText) {
			currentSheet.rootElement = new KicadParser().parse(schematicText);
		}
		const board = this.callbacks.getProjectContext()?.project.mainBoard;
		const boardText = session.getBoardText();
		if (board && boardText) {
			board.rootElement = new KicadParser().parse(boardText);
		}
	}

	protected buildSchematicNode(sheet: KicadSchematic, hierarchyPath: string): LoadedSchematicNode | null {
		if (!sheet.rootElement) {
			return null;
		}
		const children: LoadedSchematicNode[] = [];
		for (const child of sheet.sheets) {
			const node = this.buildSchematicNode(
				child, hierarchyPath ? `${ hierarchyPath }/${ child.name }` : child.name);
			if (node) {
				children.push(node);
			}
		}
		return {
			absolutePath: sheet.path || sheet.name,
			hierarchyPath,
			sheetName: sheet.name,
			text: sheet.rootElement.write(),
			children
		};
	}

	protected collectSchematicComponents(schematic: KicadSchematic): JoinedComponent[] {
		const tree = this.buildSchematicNode(schematic, '');
		if (!tree) {
			return [];
		}
		const summary = new SchematicConnectivityService().buildFromLoadedTree(tree);
		const out: JoinedComponent[] = [];
		for (const symbol of schematic.getAllSymbols(true)) {
			if (symbol.getReference().startsWith('#')) {
				continue;
			}
			const fields = symbol.getAllProperties();
			const connected = summary.components.find(c => c.ref === fields['Reference']);
			if (!connected) {
				continue;
			}
			out.push({
				ref: connected.ref,
				value: fields['Value'] ?? connected.value,
				footprintFpid: fields['Footprint'] ?? '',
				fields,
				pins: connected.pins.map(p => ({ number: p.number, net: p.net })),
				dnp: !!connected.dnp
			});
		}
		return out;
	}

	protected collectBoardFootprints(board: KicadBoard): Map<string, KicadElementFootprint> {
		const map = new Map<string, KicadElementFootprint>();
		if (!board.rootElement) {
			return map;
		}
		for (const fp of board.rootElement.findChildrenByClass(KicadElementFootprint)) {
			const ref = fp.getAllProperties()['Reference'];
			if (ref && !ref.startsWith('#')) {
				map.set(ref, fp);
			}
		}
		return map;
	}

	// ---- Diff computation (pure — same code path for dry-run preview and apply) ---

	protected recompute(): void {
		this.diff = this.computeDiff();
		this.renderReport();
	}

	protected existingNetTable(): Map<string, number> {
		const table = new Map<string, number>();
		const board = this.callbacks.getProjectContext()?.project.mainBoard;
		if (!board?.rootElement) {
			return table;
		}
		for (const net of board.rootElement.findChildrenByClass(KicadElementNet)) {
			if (!net.nameOnly && net.netName) {
				table.set(net.netName, net.id);
			}
		}
		return table;
	}

	/** Port of BOARD_NETLIST_UPDATER::UpdateNetlist — matches by reference
	 *  designator only (this app has no persistent KIID-path alternative to
	 *  offer, so the real "re-link by reference" checkbox has nothing to
	 *  turn off here). At most one PCB footprint per reference is assumed
	 *  (the overwhelmingly common real-board case — a board with duplicate
	 *  references is already malformed, and real KiCad's own best-match-
	 *  among-duplicates logic isn't worth porting for that edge case). */
	protected computeDiff(): DiffResult {
		const options = this.options();
		const actions: PlannedAction[] = [];
		const report: ReportLine[] = [];
		const matchedRefs = new Set<string>();
		const netTable = this.existingNetTable();
		let nextNetId = 1 + Math.max(0, ...[...netTable.values()]);

		const ensureNet = (name: string): number => {
			if (!name) {
				return 0;
			}
			let id = netTable.get(name);
			if (id === undefined) {
				id = nextNetId++;
				netTable.set(name, id);
				actions.push({ kind: 'add-net', name, id });
				report.push({ severity: 'action', message: `Add net "${ name }".` });
			}
			return id;
		};

		const globalLayers = this.callbacks.getProjectContext()?.project.mainBoard?.getAllLayers() ?? [];

		for (const component of this.components) {
			if (component.dnp) {
				continue;
			}
			report.push({ severity: 'info', message: `Processing symbol '${ component.ref }:${ component.value }'.` });

			if (!component.footprintFpid) {
				report.push({ severity: 'error', message: `Cannot add ${ component.ref } (no footprint assigned).` });
				continue;
			}

			const footprint = this.boardFootprints.get(component.ref);
			if (!footprint) {
				// A brand-new footprint needs its pads wired to nets just like a
				// matched one does — real KiCad's own addNewFootprint() runs pad
				// reconciliation immediately after adding, not as a separate
				// pass. The footprint object doesn't exist yet at compute time
				// (it's only resolved from the library at apply time), so the
				// per-pad net lookups happen here against the schematic's own
				// pin list and get carried on the action; applyDiff matches them
				// onto the real pads once the library footprint is in hand.
				const pins: { number: string; net: string; netId: number }[] = [];
				for (const pin of component.pins) {
					if (!pin.net) {
						continue;
					}
					pins.push({ number: pin.number, net: pin.net, netId: ensureNet(pin.net) });
				}
				actions.push({
					kind: 'add-footprint',
					ref: component.ref,
					fpid: component.footprintFpid,
					value: component.value,
					pins
				});
				report.push({
					severity: 'action',
					message: `Add ${ component.ref } (footprint '${ component.footprintFpid }').`
				});
				continue;
			}
			matchedRefs.add(component.ref);

			const existingFpid = footprint.getFootprintName() ?? '';
			let activeFootprint = footprint;
			if (existingFpid !== component.footprintFpid) {
				if (options.replaceFootprints) {
					if (footprint.isLocked() && !options.overrideLocks) {
						report.push({
							severity: 'warning',
							message: `${ component.ref } footprint is locked — skipping replacement.`
						});
					}
					else {
						actions.push({
							kind: 'replace-footprint',
							footprint,
							ref: component.ref,
							fromFpid: existingFpid,
							toFpid: component.footprintFpid
						});
						report.push({
							severity: 'action',
							message: `Changed ${ component.ref } footprint from '${ existingFpid }' to '${ component.footprintFpid }'.`
						});
					}
				}
				// Unchecked "Replace footprints": real KiCad leaves the mismatch
				// alone entirely, unreported — matched here.
			}

			const props = activeFootprint.getAllProperties();
			const fieldChanges: Record<string, string> = {};
			if (props['Value'] !== component.value) {
				fieldChanges['Value'] = component.value;
				report.push({
					severity: 'action',
					message: `Changed ${ component.ref } value from '${ props['Value']
					?? '' }' to '${ component.value }'.`
				});
			}
			if (options.updateFields) {
				for (const [name, value] of Object.entries(component.fields)) {
					if (MANDATORY_FOOTPRINT_FIELDS.has(name)) {
						continue;
					}
					if (props[name] !== value) {
						fieldChanges[name] = value;
					}
				}
			}
			const removeFields: string[] = [];
			if (options.removeExtraFields) {
				for (const name of Object.keys(props)) {
					if (MANDATORY_FOOTPRINT_FIELDS.has(name)) {
						continue;
					}
					if (!(name in component.fields)) {
						removeFields.push(name);
					}
				}
			}
			const hasNonValueFieldChange = Object.keys(fieldChanges).some(name => name !== 'Value')
				|| removeFields.length > 0;
			if (hasNonValueFieldChange) {
				report.push({ severity: 'action', message: `Updated ${ component.ref } fields.` });
			}
			if (Object.keys(fieldChanges).length || removeFields.length) {
				actions.push({ kind: 'update-fields', ref: component.ref, fields: fieldChanges, removeFields });
			}

			// Grouped by pad NUMBER, not iterated pad-by-pad — a footprint can
			// legitimately have several physical pads sharing one number (e.g.
			// SOT-223/TO-220-style parts, where a tab/heatsink pad carries the
			// same number as the leg pin it's tied to). All pads in a group
			// resolve to the same schematic pin and must all receive the same
			// net; grouping first means exactly one action/report line per
			// number instead of duplicated ones, and — critically — means
			// applyDiff (below) can mutate every physical pad in the group
			// instead of silently updating only whichever one a plain `.find()`
			// happened to hit first (the actual SOT-223 bug: one pad numbered
			// "2" got reconnected, its sibling pad also numbered "2" didn't).
			const padsByNumber = new Map<string, KicadElementPad[]>();
			for (const pad of activeFootprint.findChildrenByClass(KicadElementPad)) {
				const onCopper = pad.getLayers(globalLayers).some(l => l.endsWith('.Cu'));
				if (!onCopper || !pad.padNumber) {
					continue;
				}
				const group = padsByNumber.get(pad.padNumber);
				if (group) {
					group.push(pad);
				}
				else {
					padsByNumber.set(pad.padNumber, [pad]);
				}
			}
			for (const [padNumber, pads] of padsByNumber) {
				const pin = component.pins.find(p => p.number === padNumber);
				const netName = pin?.net ?? '';
				if (!netName) {
					report.push({
						severity: 'warning',
						message: `No net found for component ${ component.ref } pad ${ padNumber } (no pin ${ padNumber } in symbol).`
					});
					continue;
				}
				const targetNetId = ensureNet(netName);
				if (pads.some(pad => pad.getNetName() !== netName)) {
					actions.push({ kind: 'set-pad-net', ref: component.ref, padNumber, netId: targetNetId, netName });
					report.push({
						severity: 'action',
						message: `Reconnected ${ component.ref } pad ${ padNumber } to net "${ netName }".`
					});
				}
			}
		}

		for (const [ref, footprint] of this.boardFootprints) {
			if (matchedRefs.has(ref)) {
				continue;
			}
			if (options.deleteUnusedFootprints) {
				if (footprint.isLocked() && !options.overrideLocks) {
					report.push({ severity: 'warning', message: `${ ref } is locked — skipping removal.` });
				}
				else {
					actions.push({ kind: 'delete-footprint', footprint, ref });
					report.push({ severity: 'action', message: `Remove unused footprint ${ ref }.` });
				}
			}
			else {
				report.push({ severity: 'warning', message: `${ ref } has no matching symbol in the schematic.` });
			}
		}

		return { actions, report };
	}

	// ---- Apply -------------------------------------------------------------------

	/** Resolves a "Library:Name" FPID to a freshly-parsed footprint element
	 *  from the indexed library cache — same
	 *  readCachedFile→KicadParser→findFirstChildByClass(KicadElementFootprint)
	 *  pattern FootprintChooser.ts already uses to render its preview. */
	protected async resolveLibraryFootprint(fpid: string): Promise<KicadElementFootprint | null> {
		const separator = fpid.indexOf(':');
		const library = separator >= 0 ? fpid.slice(0, separator) : '';
		const name = separator >= 0 ? fpid.slice(separator + 1) : fpid;
		const files = await this.cache.getFiles();
		const file = files.find(f => f.footprints.some(fp => fp.library === library && fp.name === name));
		if (!file) {
			return null;
		}
		const text = await this.cache.readCachedFile(file.id);
		const parsed = new KicadParser().parse(text);
		const footprint = parsed.name === 'footprint'
			? parsed as KicadElementFootprint
			: parsed.findFirstChildByClass(KicadElementFootprint);
		if (!footprint) {
			return null;
		}
		footprint.setFootprintName(fpid);
		return footprint;
	}

	/** Ports estimateFootprintInsertionPosition()'s spirit (stack new
	 *  footprints below the existing board, or a fixed default point if the
	 *  board is empty) — no existing "auto-place a footprint" code anywhere
	 *  in this app to build on, confirmed during research. Uses placement-
	 *  point (not full silkscreen/pad geometry) bounding, a deliberately
	 *  simple heuristic since exact placement is something the user is
	 *  expected to adjust by hand afterward regardless. */
	protected estimateInsertionPosition(board: KicadBoard, offset: number): { x: number; y: number } {
		const footprints = board.rootElement?.findChildrenByClass(KicadElementFootprint) ?? [];
		if (!footprints.length) {
			return { x: 100 + offset * 10, y: 100 };
		}
		let maxY = -Infinity, sumX = 0;
		for (const fp of footprints) {
			const origin = fp.getOrigin();
			maxY = Math.max(maxY, origin.y);
			sumX += origin.x;
		}
		return { x: sumX / footprints.length + offset * 10, y: maxY + 10 };
	}

	protected async applyDiff(actions: PlannedAction[]): Promise<ReportLine[]> {
		const board = this.callbacks.getProjectContext()?.project.mainBoard;
		if (!board?.rootElement) {
			return [{ severity: 'error', message: 'No board is open.' }];
		}
		const applied: ReportLine[] = [];
		let addedCount = 0;
		for (const action of actions) {
			switch (action.kind) {
				case 'add-net': {
					const net = new KicadElementNet();
					net.id = action.id;
					net.netName = action.name;
					board.rootElement.children.push(net);
					applied.push({ severity: 'action', message: `Added net "${ action.name }".` });
					break;
				}
				case 'add-footprint': {
					const parsed = await this.resolveLibraryFootprint(action.fpid);
					if (!parsed) {
						applied.push({
							severity: 'error',
							message: `Cannot add ${ action.ref } (footprint '${ action.fpid }' not found).`
						});
						break;
					}
					parsed.setUuid();
					parsed.setProperty('Reference', action.ref);
					parsed.setProperty('Value', action.value);
					const pos = this.estimateInsertionPosition(board, addedCount++);
					parsed.setOrigin(pos.x, pos.y, 0);
					board.rootElement.children.push(parsed);
					this.boardFootprints.set(action.ref, parsed);
					applied.push(
						{ severity: 'action', message: `Added ${ action.ref } (footprint '${ action.fpid }').` });
					for (const pin of action.pins) {
						// Every physical pad sharing this number (see computeDiff's
						// padsByNumber grouping) — not just the first match.
						const pads = parsed.findChildrenByClass(KicadElementPad)
							.filter(p => p.padNumber === pin.number);
						if (pads.length) {
							for (const pad of pads) {
								pad.setNet(pin.netId, pin.net);
							}
							applied.push({
								severity: 'action',
								message: `Connected ${ action.ref } pad ${ pin.number } to net "${ pin.net }".`
							});
						}
					}
					break;
				}
				case 'replace-footprint': {
					const parsed = await this.resolveLibraryFootprint(action.toFpid);
					if (!parsed) {
						applied.push({
							severity: 'error',
							message: `Cannot change ${ action.ref } footprint (footprint '${ action.toFpid }' not found).`
						});
						break;
					}
					const origin = action.footprint.getOrigin();
					parsed.setOrigin(origin.x, origin.y, origin.rotation);
					parsed.setUuid(action.footprint.getUuid());
					parsed.setProperty('Reference', action.ref);
					for (const [name, value] of Object.entries(action.footprint.getAllProperties())) {
						if (name !== 'Reference' && name !== 'Footprint') {
							parsed.setProperty(name, value);
						}
					}
					const idx = board.rootElement.children.indexOf(action.footprint);
					if (idx >= 0) {
						board.rootElement.children.splice(idx, 1, parsed);
					}
					this.boardFootprints.set(action.ref, parsed);
					applied.push({
						severity: 'action',
						message: `Changed ${ action.ref } footprint from '${ action.fromFpid }' to '${ action.toFpid }'.`
					});
					break;
				}
				case 'delete-footprint': {
					const idx = board.rootElement.children.indexOf(action.footprint);
					if (idx >= 0) {
						board.rootElement.children.splice(idx, 1);
					}
					this.boardFootprints.delete(action.ref);
					applied.push({ severity: 'action', message: `Removed unused footprint ${ action.ref }.` });
					break;
				}
				case 'update-fields': {
					// Resolved by REF, not a captured object reference — if a
					// 'replace-footprint' action for the same ref already ran
					// earlier in this same actions array, this.boardFootprints
					// already points at the NEW footprint object; the old one
					// captured at compute time would be an orphaned element no
					// longer part of the board tree, silently discarding the
					// edit. Same reasoning applies to 'set-pad-net' below.
					const footprint = this.boardFootprints.get(action.ref);
					if (!footprint) {
						applied.push({
							severity: 'error',
							message: `Cannot update ${ action.ref } fields (footprint not found).`
						});
						break;
					}
					const previousValue = footprint.getAllProperties()['Value'] ?? '';
					for (const [name, value] of Object.entries(action.fields)) {
						footprint.setProperty(name, value);
					}
					for (const name of action.removeFields) {
						footprint.deleteProperty(name);
					}
					// Mirror computeDiff's own two-line split (a dedicated "Changed
					// ... value" line, plus "Updated ... fields" only when there's a
					// non-Value change too) so dry-run and applied reports stay
					// symmetric — the exact same condition, evaluated here since
					// applyDiff only sees the bundled action, not computeDiff's
					// per-line report.
					if ('Value' in action.fields) {
						applied.push({
							severity: 'action',
							message: `Changed ${ action.ref } value from '${ previousValue }' to '${ action.fields['Value'] }'.`
						});
					}
					const hasNonValueFieldChange = Object.keys(action.fields).some(name => name !== 'Value')
						|| action.removeFields.length > 0;
					if (hasNonValueFieldChange) {
						applied.push({ severity: 'action', message: `Updated ${ action.ref } fields.` });
					}
					break;
				}
				case 'set-pad-net': {
					const footprint = this.boardFootprints.get(action.ref);
					// Every physical pad sharing this number (see computeDiff's
					// padsByNumber grouping) — a plain `.find()` here silently left
					// a footprint's second same-numbered pad (e.g. a SOT-223 tab
					// pad numbered the same as its adjacent leg pin) on its old net.
					const pads = footprint?.findChildrenByClass(KicadElementPad)
						.filter(p => p.padNumber === action.padNumber) ?? [];
					if (!pads.length) {
						applied.push({
							severity: 'error',
							message: `Cannot reconnect ${ action.ref } pad ${ action.padNumber } (footprint or pad not found).`
						});
						break;
					}
					for (const pad of pads) {
						pad.setNet(action.netId, action.netName);
					}
					applied.push({
						severity: 'action',
						message: `Reconnected ${ action.ref } pad ${ action.padNumber } to net "${ action.netName }".`
					});
					break;
				}
			}
		}
		return applied;
	}

	protected async performUpdate(): Promise<void> {
		if (!this.diff.actions.length) {
			return;
		}
		this.applyBtnEl.disabled = true;
		try {
			const applied = await this.applyDiff(this.diff.actions);
			const session = this.callbacks.getSession();
			const board = this.callbacks.getProjectContext()?.project.mainBoard;
			if (session && board?.rootElement && session.getBoardText()) {
				await session.resyncBoardFromAst(board.rootElement.write() + '\n');
			}
			await this.callbacks.saveProject();
			this.callbacks.refreshSidebar();
			this.callbacks.setStatus('PCB updated from schematic.');
			this.diff = { actions: [], report: applied };
			this.renderReport();
		}
		finally {
			this.applyBtnEl.disabled = false;
		}
	}

	// ---- Report rendering ---------------------------------------------------------

	protected renderReport(): void {
		const counts: Record<ReportSeverity, number> = { error: 0, warning: 0, action: 0, info: 0 };
		for (const line of this.diff.report) {
			counts[line.severity]++;
		}
		this.countErrorsEl.textContent = String(counts.error);
		this.countWarningsEl.textContent = String(counts.warning);
		this.countActionsEl.textContent = String(counts.action);
		this.countInfosEl.textContent = String(counts.info);

		const shown: Record<ReportSeverity, boolean> = {
			error: this.filterErrorsEl.checked,
			warning: this.filterWarningsEl.checked,
			action: this.filterActionsEl.checked,
			info: this.filterInfosEl.checked
		};
		this.reportEl.replaceChildren();
		const filtered = this.diff.report.filter(line => shown[line.severity]);
		if (!filtered.length) {
			const empty = document.createElement('div');
			empty.className = 'upd-empty';
			empty.textContent = this.diff.report.length ? 'No lines match the current filter.' : 'No changes to apply.';
			this.reportEl.appendChild(empty);
		}
		else {
			for (const line of filtered) {
				const row = document.createElement('div');
				row.className = `upd-report-line upd-${ line.severity }`;
				row.textContent = line.message;
				this.reportEl.appendChild(row);
			}
		}
		this.applyBtnEl.disabled = this.diff.actions.length === 0;
	}

	protected downloadReport(): void {
		const text = this.diff.report.map(line => `[${ line.severity.toUpperCase() }] ${ line.message }`).join('\r\n');
		const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'update-pcb-from-schematic-report.txt';
		a.click();
		URL.revokeObjectURL(url);
	}
}