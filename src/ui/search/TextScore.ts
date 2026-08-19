/** Ports eeschema's LIB_TREE_NODE::UpdateScore / EDA_COMBINED_MATCHER::
 *  ScoreTerms (common/lib_tree_model.cpp, common/eda_pattern_match.cpp):
 *  AND across whitespace-separated search terms (every term must match
 *  SOMETHING or the item is excluded — returns null), OR across fields per
 *  term (only the best-scoring field counts). Per field: an exact
 *  whole-field match scores 8x that field's weight, a prefix match 2x, any
 *  other substring match 1x. Only a match on an "isName" field (never
 *  keywords/description) can set `exact`, which real KiCad's sort ranks
 *  above raw score. Extracted from SymbolChooser/FootprintChooser, which
 *  had this scoring logic duplicated byte-for-byte apart from which fields
 *  they scored — every caller supplies its own weighted field list instead. */

export interface ScoreField {
	text: string | undefined;
	weight: number;
	isName: boolean;
}

export interface ScoreResult {
	score: number;
	exact: boolean;
}

export function normalizeText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function scoreSearchQuery(query: string, fields: ScoreField[]): ScoreResult | null {
	const cleanedQuery = normalizeText(query);
	if (!cleanedQuery) {
		return { score: 0, exact: false };
	}
	const terms = cleanedQuery.split(/\s+/).filter(Boolean);

	let total = 0, anyExact = false;
	for (const term of terms) {
		let bestFieldScore = 0, bestFieldExact = false;
		for (const field of fields) {
			const normalized = normalizeText(field.text ?? '');
			if (!normalized) {
				continue;
			}
			let fieldScore = 0, fieldExact = false;
			if (normalized === term) {
				fieldScore = 8 * field.weight;
				fieldExact = field.isName;
			}
			else if (normalized.startsWith(term)) {
				fieldScore = 2 * field.weight;
			}
			else if (normalized.includes(term)) {
				fieldScore = field.weight;
			}
			if (fieldScore > bestFieldScore) {
				bestFieldScore = fieldScore;
				bestFieldExact = fieldExact;
			}
		}
		if (bestFieldScore <= 0) {
			return null;
		}
		total += bestFieldScore;
		anyExact = anyExact || bestFieldExact;
	}
	return { score: total, exact: anyExact };
}

/** Scores+filters `rows` against `query`, then sorts: while searching,
 *  exact-match items first, then by score, falling back to `sortKey`
 *  (matches LIB_TREE_NODE::Compare's tier order); with no search text,
 *  plain `sortKey` order. */
export function scoreAndSort<T>(
	query: string, rows: T[], toFields: (item: T) => ScoreField[], sortKey: (item: T) => string
): T[] {
	const searching = normalizeText(query).length > 0;
	const scored: { item: T; score: number; exact: boolean }[] = [];
	for (const item of rows) {
		const result = scoreSearchQuery(query, toFields(item));
		if (result) {
			scored.push({ item, score: result.score, exact: result.exact });
		}
	}
	scored.sort((a, b) => {
		if (searching) {
			if (a.exact !== b.exact) {
				return a.exact ? -1 : 1;
			}
			if (a.score !== b.score) {
				return b.score - a.score;
			}
		}
		return naturalCompare(sortKey(a.item), sortKey(b.item));
	});
	return scored.map(entry => entry.item);
}

export interface ScoredGroupCompareInput {
	label: string;
	bestScore: number;
	bestExact: boolean;
}

/** Real KiCad's group order while searching (`LIB_TREE_NODE_LIBRARY::
 *  UpdateScore`, common/lib_tree_model.cpp): a library's own score is the
 *  MAX of its children's scores, exact-match if ANY child is exact — "the
 *  library holding the single best match floats to the top." Falls back to
 *  alphabetical with no search text or on a tie. */
export function defaultCompareScoredGroups(
	a: ScoredGroupCompareInput, b: ScoredGroupCompareInput, searching: boolean
): number {
	if (searching) {
		if (a.bestExact !== b.bestExact) {
			return a.bestExact ? -1 : 1;
		}
		if (a.bestScore !== b.bestScore) {
			return b.bestScore - a.bestScore;
		}
	}
	return naturalCompare(a.label, b.label);
}

/** Buckets `items` by `groupKey`, scores+sorts each bucket's rows via
 *  `scoreAndSort`, then sorts the buckets themselves by their best-matching
 *  row's score (`defaultCompareScoredGroups`, or a caller-supplied variant —
 *  see `SymbolChooser`'s Device-library tie-break) — the "search reorders
 *  which library floats to the top" behavior every grouped/scored list in
 *  this app shares (`LibraryChooser`'s modal choosers, the Symbol Editor's
 *  always-visible Libraries pane), extracted so it's genuinely one
 *  implementation instead of the bucket/score/sort logic copy-pasted at
 *  each call site. A bucket that scores no matching rows is dropped
 *  entirely, same as an empty search result for a flat list. */
export function buildScoredGroups<T>(
	query: string, items: T[], groupKey: (item: T) => string, toFields: (item: T) => ScoreField[],
	sortKey: (item: T) => string,
	compareGroups: (a: ScoredGroupCompareInput, b: ScoredGroupCompareInput, searching: boolean) => number
		= defaultCompareScoredGroups
): { label: string; rows: T[] }[] {
	const searching = normalizeText(query).length > 0;
	const byGroup = new Map<string, T[]>();
	for (const item of items) {
		const key = groupKey(item);
		(byGroup.get(key) ?? byGroup.set(key, []).get(key)!).push(item);
	}
	const groups: { label: string; rows: T[]; bestScore: number; bestExact: boolean }[] = [];
	for (const key of byGroup.keys()) {
		const rows = scoreAndSort(query, byGroup.get(key)!, toFields, sortKey);
		if (!rows.length) {
			continue;
		}
		// rows[0] is already this group's best match (scoreAndSort put it
		// first) — re-score just that one row instead of tracking scores
		// through the whole sort.
		const best = searching ? scoreSearchQuery(query, toFields(rows[0]!)) : null;
		groups.push({ label: key, rows, bestScore: best?.score ?? 0, bestExact: best?.exact ?? false });
	}
	groups.sort((a, b) => compareGroups(a, b, searching));
	return groups.map(({ label, rows }) => ({ label, rows }));
}
