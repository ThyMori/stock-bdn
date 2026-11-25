import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data } from '../src/types';
import { inUpcomingShows, planItem, summarize, validateChanges } from '../src/batchEdit';

const it = (id: number, type: string, o: Record<string, unknown> = {}) => ({ id, model_id: 'M' + type, lamp_id: null, status: 'dispo', blue_dot: false, ...o }) as unknown as Data['items'][number];
const d = { ...EMPTY_DATA, types: [{ id: 'PAR', name: 'PAR' }, { id: 'PC', name: 'PC' }], models: [{ id: 'MPAR', name: 'PAR64', type_id: 'PAR' }, { id: 'MPC', name: 'PC 1kW', type_id: 'PC' }],
  lamps: [{ id: 'L1', name: 'CP62' }, { id: 'L2', name: 'CP61' }], items: [it(1, 'PAR'), it(2, 'PC'), it(3, 'PAR', { blue_dot: true, lamp_id: 'L1', status: 'sav' })],
  shows: [{ id: 's1', name: 'S', start_date: '2026-11-20', end_date: '2026-11-29' }, { id: 's0', name: 'Vieux', start_date: '2026-01-01', end_date: '2026-01-05' }],
  showItems: [{ show_id: 's1', item_id: 1 }, { show_id: 's0', item_id: 2 }] } as unknown as Data;
const today = '2026-11-25';

// validation
assert.ok(validateChanges({}, today));
assert.equal(validateChanges({ blue: true }, today), null);
assert.ok(validateChanges({ status: { kind: 'sav', note: ' ', who: '', until: '' } }, today));
assert.ok(validateChanges({ status: { kind: 'en_pret', note: '', who: '', until: '' } }, today));
assert.ok(validateChanges({ status: { kind: 'en_pret', note: '', who: 'Vidy', until: '2026-11-01' } }, today));
assert.equal(validateChanges({ status: { kind: 'en_pret', note: '', who: 'Vidy', until: '2026-12-01' } }, today), null);
assert.equal(validateChanges({ status: { kind: 'dispo', note: '', who: '', until: '2020-01-01' } }, today), null);   // la fin prévue ne compte pas pour « disponible »

// plan : pastille, lampe, état ; refus de lampe sur un non-PAR sans bloquer les autres réglages
const c = { blue: true, lamp: 'L2', status: { kind: 'sav' as const, note: 'Nettoyage', who: '', until: '' } };
let p = planItem(d, 1, c); assert.deepEqual(p.steps.map((s) => s.kind), ['blue', 'lamp', 'status']); assert.equal(p.refused.length, 0);
p = planItem(d, 2, c); assert.deepEqual(p.steps.map((s) => s.kind), ['blue', 'status']); assert.equal(p.refused.length, 1);
p = planItem(d, 3, c); assert.deepEqual(p.steps.map((s) => s.kind), ['lamp']); assert.equal(p.unchanged.length, 2);   // déjà bleu et déjà en SAV
assert.deepEqual(planItem(d, 9, c).refused, ['introuvable']);
p = planItem(d, 3, { lamp: 'L1' }); assert.equal(p.steps.length, 0); assert.equal(p.unchanged.length, 1);
p = planItem(d, 1, { blue: false }); assert.equal(p.steps.length, 0);

// résumé et avertissement spectacles
assert.deepEqual(summarize(d, { blue: false, lamp: 'L2', status: { kind: 'en_pret', note: '', who: 'Vidy', until: '2026-12-01' } }),
  ['Retirer la pastille bleue', 'Lampe : CP61 (PAR seulement)', 'État : prêt à Vidy, retour prévu le 01/12/2026']);
assert.equal(inUpcomingShows(d, [1, 2, 3], today), 1);                    // n° 1 dans un spectacle en cours ; le n° 2 n'est que dans un spectacle passé
console.log('batch-edit OK');
