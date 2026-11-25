import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data } from '../src/types';
import { teardownPlan } from '../src/teardown';

const show = (id: string, s: string, e: string) => ({ id, name: id, start_date: s, end_date: e }) as unknown as Data['shows'][number];
const A = show('A', '2026-11-01', '2026-11-10'), B = show('B', '2026-11-20', '2026-11-29');
const it = (id: number, blue: boolean) => ({ id, model_id: 'M', lamp_id: null, status: 'dispo', blue_dot: blue }) as unknown as Data['items'][number];
const si = (show_id: string, item_id: number, zone = '') => ({ show_id, item_id, lamp_id: null, zone }) as unknown as Data['showItems'][number];
const pl = (show_id: string, item_id: number, position: string) => ({ show_id, item_id, position }) as unknown as Data['patchLines'][number];
const d = { ...EMPTY_DATA, shows: [A, B], models: [{ id: 'M', name: 'PC' }], types: [{ id: 't', name: 'PC' }], items: [1, 2, 3, 4, 5, 6].map((i) => it(i, i === 2 || i === 6)),
  showItems: [si('A', 1), si('A', 2), si('A', 3), si('B', 1, 'plateau'), si('B', 3, 'face'), si('B', 4, 'face'), si('B', 5, 'plateau'), si('B', 6)],
  patchLines: [pl('A', 1, 'P3'), pl('A', 2, '3e balcon'), pl('A', 3, 'P4'), pl('B', 1, 'P3'), pl('B', 3, '2e balcon'), pl('B', 4, 'coupole'), pl('B', 5, 'P5'), pl('B', 6, 'corbeille')] } as unknown as Data;
const p = teardownPlan(d, 'A', 'B');
assert.deepEqual(p.stock3.map((r) => r.id), [2]);                          // pastille bleue, absent de B → rangé au 3e
assert.deepEqual(p.dessous.map((r) => r.id), []);
assert.deepEqual(p.keep.map((r) => [r.id, r.zone]), [[1, 'plateau']]);        // même position, zone retenue
assert.deepEqual(p.move.map((r) => [r.id, r.zone]), [[3, 'face']]);         // P4 → 2e balcon, zone face
assert.deepEqual(p.mount.map((r) => [r.id, r.zone, r.originKind]).sort(), [[4, 'face', 'dessous'], [5, 'plateau', 'dessous'], [6, 'corbeille', 'stock3']]);
assert.equal(p.fromDessous, 2); assert.equal(p.fromStock3, 1);              // 4 et 5 sans pastille (dessous), 6 pastille bleue (3e)
// zone non retenue : déduite de la position
const d2 = { ...d, showItems: d.showItems.map((r) => (r.show_id === 'B' && r.item_id === 6 ? { ...r, zone: '' } : r)) } as Data;
assert.equal(teardownPlan(d2, 'A', 'B').mount.find((r) => r.id === 6)?.zone, 'corbeille');
console.log('teardown OK');
