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

// PAR : bonne lampe du précédent d'abord, puis (en dernier) PAR du précédent à relamper ; jamais le stock
d = base({ items: [it(1, 'P', 'A'), it(2, 'P', 'B'), it(3, 'P', 'A'), it(4, 'P', 'B')], showItems: [si('prev', 1, 'A'), si('prev', 2, 'B')], showDemands: [dem('d1', 'P', 4, 'A')] });
p = preAssignPlan(d, cur, prev);
assert.deepEqual(p.proposals.map((x) => [x.item, x.relamp, x.from]), [[1, false, 'prev'], [2, true, 'prev']]);   // 3 et 4 sont en stock : ignorés
assert.deepEqual(p.shortages.map((x) => x.n), [2]);
d = { ...d, showDemands: [dem('d1', 'P', 1, 'A')] };
assert.deepEqual(preAssignPlan(d, cur, prev).proposals.map((x) => x.item), [1]);

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

// ---- v1.58.0 : zones, positions, pastille bleue, repli ----
const itb = (id: number, model: string, blue: boolean, lamp: string | null = null) => ({ ...it(id, model, lamp), blue_dot: blue }) as unknown as Data['items'][number];
const pl = (item_id: number, position: string) => ({ show_id: 'prev', item_id, position }) as unknown as Data['patchLines'][number];
const sl = (demand_id: string, zone: string, position: string | null, qty: number) => ({ id: demand_id + zone + position, show_id: 'cur', demand_id, zone, position, qty }) as unknown as Data['showDemandSlots'][number];
const zd = (o: Partial<Data>) => base({ showDemands: [dem('d1', 'M', 2)], ...o });
const ids = (pp: ReturnType<typeof preAssignPlan>) => pp.proposals.map((x) => x.item);

// plateau 2 : même zone d'abord ; autre zone sans pastille ok ; autre zone AVEC pastille écartée
d = zd({ items: [itb(1, 'M', false), itb(2, 'M', false), itb(3, 'M', true)], showItems: [si('prev', 1), si('prev', 2), si('prev', 3)],
  patchLines: [pl(1, 'P3'), pl(2, '3e balcon'), pl(3, '3e balcon')], showDemandSlots: [sl('d1', 'plateau', null, 2)] });
p = preAssignPlan(d, cur, prev);
assert.deepEqual(ids(p), [1, 2]); assert.deepEqual(p.proposals.map((x) => x.how), ['same', 'cross']); assert.equal(p.proposals[0].zone, 'plateau');
// le n°3 (pastille bleue, au 3e balcon) n'est pas repris : il sera rangé au 3e ; aucun stock → il manque (sauf repêchage ci-dessous)
assert.equal(p.prepNeeds.length, 0);

// face 1 : l'autre zone n'est acceptée qu'avec pastille bleue
d = zd({ showDemands: [dem('d1', 'M', 1)], items: [itb(1, 'M', false), itb(2, 'M', true)], showItems: [si('prev', 1), si('prev', 2)],
  patchLines: [pl(1, 'P3'), pl(2, 'P4')], showDemandSlots: [sl('d1', 'face', null, 1)] });
assert.deepEqual(ids(preAssignPlan(d, cur, prev)), [2]);

// position précise : P5 d'abord
d = zd({ showDemands: [dem('d1', 'M', 1)], items: [itb(1, 'M', false), itb(2, 'M', false)], showItems: [si('prev', 1), si('prev', 2)],
  patchLines: [pl(1, 'P3'), pl(2, 'P5')], showDemandSlots: [sl('d1', 'plateau', null, 1), sl('d1', 'plateau', 'P5', 1)] });
assert.deepEqual(ids(preAssignPlan(d, cur, prev)), [2]);

// position inconnue = « autre zone » : plateau sans pastille ok, face seulement avec pastille
d = zd({ showDemands: [dem('d1', 'M', 1)], items: [itb(1, 'M', false)], showItems: [si('prev', 1)], showDemandSlots: [sl('d1', 'plateau', null, 1)] });
assert.deepEqual(ids(preAssignPlan(d, cur, prev)), [1]);
d = { ...d, showDemandSlots: [sl('d1', 'face', null, 1)] };
assert.deepEqual(ids(preAssignPlan(d, cur, prev)), [1]);                  // écarté mais aucun stock : repêché
assert.equal(preAssignPlan(d, cur, prev).proposals[0].how, 'repeche');

// à préparer : plateau → dessous, face → 3e ; le stock existant évite le repêchage
d = zd({ showDemands: [dem('d1', 'M', 3)], items: [itb(1, 'M', true), itb(2, 'M', false), itb(3, 'M', true), itb(4, 'M', false)], showItems: [si('prev', 1)],
  patchLines: [pl(1, '3e balcon')], showDemandSlots: [sl('d1', 'plateau', null, 2), sl('d1', 'face', null, 1)] });
p = preAssignPlan(d, cur, prev);
assert.deepEqual(ids(p), [1]);                                           // le n°1 va en face (même zone)
assert.deepEqual(p.prepNeeds.map((x) => [x.zone, x.from, x.n, x.fallback]), [['plateau', 'dessous', 2, false]]);   // n°2 et n°4 : 2 dessous
assert.equal(p.shortages[0].n, 2);

// repli : face demandée, plus rien au 3e mais un dessous → préparé depuis les dessous (repli)
d = zd({ showDemands: [dem('d1', 'M', 1)], items: [itb(2, 'M', false)], showDemandSlots: [sl('d1', 'face', null, 1)] });
p = preAssignPlan(d, cur, prev);
assert.deepEqual(p.prepNeeds.map((x) => [x.zone, x.from, x.fallback]), [['face', 'dessous', true]]);
// rien du tout : introuvable
d = zd({ showDemands: [dem('d1', 'M', 1)], items: [], showDemandSlots: [sl('d1', 'face', null, 1)] });
p = preAssignPlan(d, cur, prev); assert.equal(p.unavailable[0].n, 1); assert.equal(p.prepNeeds.length, 0);

// déjà affecté avec sa zone : réduit le besoin de cette zone
d = zd({ showDemands: [dem('d1', 'M', 2)], items: [itb(1, 'M', false), itb(2, 'M', false), itb(3, 'M', false)],
  showItems: [{ ...si('cur', 1), zone: 'face' } as never, si('prev', 2), si('prev', 3)], patchLines: [pl(2, 'P3'), pl(3, '2e balcon')],
  showDemandSlots: [sl('d1', 'face', null, 1), sl('d1', 'plateau', null, 1)] });
p = preAssignPlan(d, cur, prev);
assert.deepEqual(ids(p), [2]); assert.equal(p.proposals[0].zone, 'plateau');       // la face est déjà couverte par le n°1

// sans répartition : comportement d'avant (tout « sans zone »)
d = zd({ showDemands: [dem('d1', 'M', 2)], items: [itb(1, 'M', true), itb(2, 'M', false)], showItems: [si('prev', 1), si('prev', 2)] });
p = preAssignPlan(d, cur, prev); assert.deepEqual(ids(p), [1, 2]); assert.equal(p.proposals[0].zone, '');
console.log('pre-assign OK');
