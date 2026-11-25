import assert from 'node:assert/strict';
import { zoneLabel, zoneOfPosition } from '../src/zones';

// plateau : perches, cage de scène, sol, pont coupole
for (const p of ['P0', 'P5', 'P10', 'allemande J', 'allemande C', 'passerelle J', 'mezza C', 'sol', 'pont coupole']) assert.equal(zoneOfPosition(p), 'plateau', p);
// face : balcons et coupole (≠ pont coupole)
for (const p of ['2e balcon', '3e balcon', 'coupole']) assert.equal(zoneOfPosition(p), 'face', p);
assert.equal(zoneOfPosition('corbeille'), 'corbeille');
// sans zone : « autre », vide, inconnu, P11 n'existe pas
for (const p of ['autre', '', null, undefined, 'P11', 'cour']) assert.equal(zoneOfPosition(p as string), '', String(p));
assert.equal(zoneOfPosition('  Corbeille '), 'corbeille');   // espaces et majuscules ignorés
assert.equal(zoneLabel('face'), 'Face'); assert.equal(zoneLabel(''), ''); assert.equal(zoneLabel(undefined), '');
console.log('zones OK');
