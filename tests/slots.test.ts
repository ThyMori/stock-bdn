import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data } from '../src/types';
import { slotsOf, slotsText, slotsTotal, validateSlots, zoneCount } from '../src/slots';
import { positionsOfZone } from '../src/zones';

const data = { ...EMPTY_DATA, showDemandSlots: [
  { id: 'a', show_id: 's', demand_id: 'd1', zone: 'plateau', position: null, qty: 8 }, { id: 'b', show_id: 's', demand_id: 'd1', zone: 'plateau', position: 'P5', qty: 4 },
  { id: 'c', show_id: 's', demand_id: 'd1', zone: 'face', position: null, qty: 4 }, { id: 'd', show_id: 's', demand_id: 'd2', zone: 'corbeille', position: null, qty: 1 }] } as Data;
const s = slotsOf(data, 'd1');
assert.equal(s.length, 3); assert.equal(zoneCount(s, 'plateau'), 8); assert.equal(zoneCount(s, 'face'), 4); assert.equal(zoneCount(s, 'corbeille'), 0); assert.equal(slotsTotal(s), 12);
assert.equal(validateSlots(s, 12), null);
assert.match(validateSlots(s, 10)!, /dépasse la quantité/);                              // 12 réparti pour 10 demandés
assert.match(validateSlots([{ zone: 'face', position: null, qty: 1 }, { zone: 'face', position: 'coupole', qty: 2 }], 5)!, /dépassent le nombre de la zone/);
assert.match(validateSlots([{ zone: 'face', position: 'coupole', qty: 1 }], 5)!, /dépassent/);   // position sans nombre de zone
assert.equal(validateSlots([], 5), null);                                                 // rien réparti : valide
assert.equal(slotsText(s, { plateau: 'Plateau', face: 'Face', corbeille: 'Corbeille' }), 'Plateau 8 (P5 : 4) · Face 4');
assert.equal(slotsText([], {}), '');
assert.deepEqual(positionsOfZone('face'), ['2e balcon', '3e balcon', 'coupole']);
assert.deepEqual(positionsOfZone('corbeille'), ['corbeille']);
assert.equal(positionsOfZone('plateau').includes('pont coupole') && positionsOfZone('plateau').includes('P10') && positionsOfZone('plateau').includes('mezza C'), true);
console.log('slots OK');
