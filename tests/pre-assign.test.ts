import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data } from '../src/types';
import { defaultPrevious, preAssignPlan, previousShows } from '../src/preAssign';

const show = (id: string, s: string, e: string) => ({ id, name: id, start_date: s, end_date: e }) as unknown as Data['shows'][number];
const it = (id: number, model: string, lamp: string | null = null) => ({ id, model_id: model, lamp_id: lamp, status: 'dispo' }) as unknown as Data['items'][number];
const prev = show('prev', '2026-11-01', '2026-11-10'), cur = show('cur', '2026-11-20', '2026-11-29'), old = show('old', '2026-10-01', '2026-10-05');
const base = (o: Partial<Data>): Data => ({ ...EMPTY_DATA, shows: [old, prev, cur], ...o }) as Data;
const dem = (id: string, model: string, qty: number, lamp: string | null = null, missing = 0) => ({ id, show_id: 'cur', model_id: model, lamp_id: lamp, qty, missing }) as unknown as Data['showDemands'][number];
const si = (show_id: string, item_id: number, lamp_id: string | null = null) => ({ show_id, item_id, lamp_id }) as unknown as Data['showItems'][number];

// liste et défaut : ordre chronologique, spectacle en cours d'abord, sinon le plus proche
assert.deepEqual(previousShows(base({}), cur).map((s) => s.id), ['old', 'prev']);
assert.equal(defaultPrevious([old, prev], '2026-11-05')?.id, 'prev');
assert.equal(defaultPrevious([old, prev], '2026-11-15')?.id, 'prev');
assert.equal(defaultPrevious([], '2026-11-15'), null);

// non-PAR : seulement le précédent, quantité limitée, manque signalé
let d = base({ items: [it(1, 'M'), it(2, 'M'), it(3, 'M')], showItems: [si('prev', 1), si('prev', 2)], showDemands: [dem('d1', 'M', 3)] });
let p = preAssignPlan(d, cur, prev);
assert.deepEqual(p.proposals.map((x) => x.item), [1, 2]);
assert.deepEqual(p.shortages.map((x) => x.n), [1]);                      // le n°3 est en stock : non pioché pour un non-PAR

// PAR : bonne lampe du précédent, puis stock bonne lampe, puis stock à relamper, puis précédent à relamper
d = base({ items: [it(1, 'P', 'A'), it(2, 'P', 'B'), it(3, 'P', 'A'), it(4, 'P', 'B')], showItems: [si('prev', 1, 'A'), si('prev', 2, 'B')], showDemands: [dem('d1', 'P', 4, 'A')] });
p = preAssignPlan(d, cur, prev);
assert.deepEqual(p.proposals.map((x) => [x.item, x.relamp, x.from]), [[1, false, 'prev'], [3, false, 'stock'], [4, true, 'stock'], [2, true, 'prev']]);
d = { ...d, showDemands: [dem('d1', 'P', 2, 'A')] };
assert.deepEqual(preAssignPlan(d, cur, prev).proposals.map((x) => x.item), [1, 3]);
d = { ...d, showDemands: [dem('d1', 'P', 3, 'A')] };
assert.deepEqual(preAssignPlan(d, cur, prev).proposals.map((x) => x.item), [1, 3, 4]);   // relampage du stock avant celui du précédent

// exclusions : panne non bloquante, SAV, déjà dans le spectacle ; déjà affectés comptés ; prêts / manque déduits
d = base({ items: [it(1, 'M'), it(2, 'M'), it(3, 'M'), it(4, 'M')], showItems: [si('prev', 1), si('prev', 2), si('prev', 3), si('cur', 4)],
  faults: [{ id: 'f', item_id: 1, resolved_at: null, keep_until: '2026-11-29' }] as unknown as Data['faults'],
  immos: [{ item_id: 2, kind: 'sav', start_date: '2026-11-15', end_date: null, closed_date: null }] as unknown as Data['immos'],
  showDemands: [dem('d1', 'M', 4)] });
p = preAssignPlan(d, cur, prev);
assert.deepEqual(p.proposals.map((x) => x.item), [3]);
assert.equal(p.alreadyOk, 1);
assert.equal(p.shortages[0].n, 2);                                       // 4 demandés − 1 déjà affecté − 1 proposé
d = { ...d, showDemands: [dem("d1", "M", 4, null, 2)] };
assert.equal(preAssignPlan(d, cur, prev).shortages.length, 0);
console.log('pre-assign OK');
