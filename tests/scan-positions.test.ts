import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data } from '../src/types';
import { classifyScan, splitLot } from '../src/scanPositions';

const data = { ...EMPTY_DATA,
  families: [{ id: 'f', name: 'F' }], types: [{ id: 't1', name: 'PAR', family_id: 'f' }, { id: 't2', name: 'Découpe', family_id: 'f' }],
  models: [{ id: 'mp', name: 'PAR64', type_id: 't1' }, { id: 'md', name: '614', type_id: 't2' }],
  items: [{ id: 1, model_id: 'mp', lamp_id: 'L1' }, { id: 2, model_id: 'mp', lamp_id: null }, { id: 3, model_id: 'md', lamp_id: null }, { id: 4, model_id: 'mp', lamp_id: 'L2' }],
  showItems: [{ show_id: 's', item_id: 3 }] } as unknown as Data;

assert.deepEqual(classifyScan(data, 's', null, []), { ok: false, msg: 'QR non reconnu.' });
assert.deepEqual(classifyScan(data, 's', 99, []), { ok: false, msg: 'Projecteur n° 99 introuvable.' });
assert.deepEqual(classifyScan(data, 's', 3, [1]), { ok: true, inShow: true });
assert.deepEqual(classifyScan(data, 's', 1, [3]), { ok: true, inShow: false });
assert.deepEqual(classifyScan(data, 's', 1, [1]), { ok: false, msg: 'N° 1 déjà dans le lot.' });
// lot : 3 déjà dans le spectacle ; 1 et 4 à affecter (une lampe chacun) ; 2 est un PAR sans lampe → refusé
const r = splitLot(data, 's', [3, 1, 2, 4]);
assert.deepEqual(r.inShow, [3]); assert.deepEqual(r.noLamp, [2]);
assert.deepEqual([...r.out.entries()], [['L1', [1]], ['L2', [4]]]);
console.log('scan-positions OK');
