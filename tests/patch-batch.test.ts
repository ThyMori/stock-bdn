import assert from 'node:assert/strict';
import { batchActions, batchTargets, lignes, rangeKeys } from '../src/patchBatch';

// clés → cibles : les clés inconnues sont ignorées
const id = '123e4567-e89b-12d3-a456-426614174000';
assert.deepEqual(batchTargets(['i12', `l${id}`, 'zz', 'i']), [{ item: 12 }, { line: id }]);
// plage entre deux lignes, dans les deux sens ; ligne non affichée : seule la cible
const o = ['a', 'b', 'c', 'd', 'e'];
assert.deepEqual(rangeKeys(o, 'b', 'd'), ['b', 'c', 'd']);
assert.deepEqual(rangeKeys(o, 'd', 'b'), ['b', 'c', 'd']);
assert.deepEqual(rangeKeys(o, 'x', 'c'), ['c']);
// droits : le technicien ne voit que grada, courbe et gélatines
assert.deepEqual(batchActions(false).map(([k]) => k), ['curve', 'gel_add', 'gel_clear', 'clear_dimmer']);
assert.ok(batchActions(true).some(([k]) => k === 'position'));
assert.equal(lignes(1), '1 ligne'); assert.equal(lignes(4), '4 lignes');
console.log('patch-batch : OK');
