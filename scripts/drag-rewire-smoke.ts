import fs from 'node:fs';
import { KicadParser } from '@kicad-io/KicadParser';
import {
	lockNetlistFromSchematic,
	rewireSchematic,
	type CircuitPlacement,
	type LockedNetlist,
} from '@kicad-layout/index';

const schematicPath = process.argv[2];
if (!schematicPath) throw new Error('Expected a .kicad_sch path');
const text = fs.readFileSync(schematicPath, 'utf8');
const locked = lockNetlistFromSchematic(text);

const root = new KicadParser().parse(text);
const placements: CircuitPlacement[] = (root.children ?? [])
	.filter((el: any) => el?.name === 'symbol' && typeof el.getReference === 'function' && typeof el.getOrigin === 'function')
	.map((el: any) => {
		const origin = el.getOrigin();
		const ref = String(el.getReference() ?? '');
		return {
			ref,
			role: ref.startsWith('#') ? 'GND' : 'PART',
			libId: String(el.getLibId?.() ?? ''),
			x: origin.x, y: origin.y, rotation: origin.rotation ?? 0,
			value: ref,
			pinNets: { ...(locked.pinNetsByRef[ref] ?? {}) },
			nets: Object.values(locked.pinNetsByRef[ref] ?? {}),
		};
	})
	.filter(p => p.ref);

/**
 * Canonical connectivity PARTITION: the sets of `ref.pin` members grouped by
 * net, ignoring net names (a wired net loses its label so its name changes, and
 * anonymous nets pick a different naming pin, but the grouping must not change).
 *
 * Excludes power-flag pins (`#PWR…`/`#FLG…`) — per-pin GND symbols are
 * regenerated with fresh refs, so their pin ids legitimately change. The
 * invariant is about REAL component-pin connectivity.
 */
function partitionSignature(l: LockedNetlist): string {
	const byNet = new Map<string, string[]>();
	for (const [ref, pins] of Object.entries(l.pinNetsByRef)) {
		if (ref.startsWith('#')) {
			continue;
		}
		for (const [pin, net] of Object.entries(pins)) {
			const arr = byNet.get(net) ?? [];
			arr.push(`${ref}.${pin}`);
			byNet.set(net, arr);
		}
	}
	return [...byNet.values()]
		.filter(members => members.length > 0)
		.map(members => members.sort().join('+'))
		.sort()
		.join('\n');
}

const before = partitionSignature(locked);
const beforeGroups = new Set(before.split('\n'));

// Core invariant: rip up ALL connectivity and regenerate it from the locked
// netlist at the current poses — the partition (which pins share a net) must be
// identical. rewireSchematic keeps the file's symbol positions, so `placements`
// must match those poses (the app updates poses via the render session before
// calling; here we pass the originals).
const result = rewireSchematic({ schematicText: text, placements, locked });
const after = partitionSignature(lockNetlistFromSchematic(result.kicadSchFull));
const afterGroups = new Set(after.split('\n'));

const dropped = [...beforeGroups].filter(g => !afterGroups.has(g));
const added = [...afterGroups].filter(g => !beforeGroups.has(g));
const connectivityPreserved = dropped.length === 0 && added.length === 0;

console.log(JSON.stringify({
	placements: placements.length,
	nets: locked.summary.netCount,
	segments: result.segments.length,
	invalidNets: result.invalidNets,
	connectivityPreserved,
	// On mismatch, show which net member-sets changed (before → after).
	changed: connectivityPreserved ? undefined : { droppedGroups: dropped, addedGroups: added },
}, null, 2));
if (!connectivityPreserved) process.exitCode = 1;
