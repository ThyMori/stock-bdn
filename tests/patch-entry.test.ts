import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data } from '../src/types';
import { dmxValue, entryOf, entryOps, keypad } from '../src/patchEntry';

const data = { ...EMPTY_DATA, patchLines: [
  { id: 'a', show_id: 's', item_id: 1, dimmer: '12', curve: ['lineaire'], dmx: '' },
  { id: 'b', show_id: 's', item_id: 2, dimmer: '7', curve: ['direct'], dmx: '1-45' }] } as unknown as Data;
assert.deepEqual(entryOf(data, 's', 1), { dimmer: '12', direct: false, universe: '', address: '' });
assert.deepEqual(entryOf(data, 's', 2), { dimmer: '7', direct: true, universe: '1', address: '45' });
assert.deepEqual(entryOf(data, 's', 9), { dimmer: '', direct: false, universe: '', address: '' });   // pas de ligne

// pavé
assert.equal(keypad('', '4'), '4'); assert.equal(keypad('4', '2'), '42'); assert.equal(keypad('42', 'back'), '4'); assert.equal(keypad('42', 'clear'), '');
assert.equal(keypad('123456', '7'), '123456'); assert.equal(keypad('1', 'x'), '1');

// DMX
assert.deepEqual(dmxValue('', ''), { value: '' }); assert.deepEqual(dmxValue('1', '45'), { value: '1-45' }); assert.deepEqual(dmxValue('02', '007'), { value: '2-7' });
for (const [u, a] of [['1', ''], ['', '5'], ['0', '5'], ['1', '513'], ['1', '0'], ['1000', '5']]) assert.ok('error' in dmxValue(u, a), `${u}/${a}`);

// envois : grada seule ; DIRECT + DMX (courbe d'abord) ; retrait de DIRECT ; rien à faire ; DMX invalide
const e0 = entryOf(data, 's', 1);
assert.deepEqual(entryOps(e0, { ...e0, dimmer: '15' }), [{ field: 'dimmer', value: '15' }]);
assert.deepEqual(entryOps(e0, { ...e0, direct: true, universe: '1', address: '120', dimmer: '15' }), [{ field: 'curve', value: ['direct'] }, { field: 'dmx', value: '1-120' }, { field: 'dimmer', value: '15' }]);
assert.deepEqual(entryOps(e0, { ...e0, direct: true }), [{ field: 'curve', value: ['direct'] }]);           // DIRECT sans adresse : permis
const e2 = entryOf(data, 's', 2);
assert.deepEqual(entryOps(e2, { ...e2, direct: false, universe: '', address: '' }), [{ field: 'curve', value: ['lineaire'] }]);
assert.deepEqual(entryOps(e2, { ...e2, address: '46' }), [{ field: 'dmx', value: '1-46' }]);
assert.deepEqual(entryOps(e2, { ...e2 }), []);
assert.ok('error' in (entryOps(e0, { ...e0, direct: true, universe: '1', address: '' }) as object));
console.log('patch-entry OK');
