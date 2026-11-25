import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data } from '../src/types';
import { prepScanTarget, remainingNeeds } from '../src/prepNeeds';

const show = (id: string, s: string, e: string) => ({ id, name: id, start_date: s, end_date: e }) as unknown as Data['shows'][number];
const prev = show('prev', '2026-11-01', '2026-11-10'), cur = show('cur', '2026-11-20', '2026-11-29');
const it = (id: number, model: string, blue: boolean, lamp: string | null = null) => ({ id, model_id: model, lamp_id: lamp, status: 'dispo', blue_dot: blue }) as unknown as Data['items'][number];
const dem = (id: string, model: string, qty: number, lamp: string | null = null) => ({ id, show_id: 'cur', model_id: model, lamp_id: lamp, qty, missing: 0 }) as unknown as Data['showDemands'][number];
const sl = (demand_id: string, zone: string, qty: number) => ({ id: demand_id + zone, show_id: 'cur', demand_id, zone, position: null, qty }) as unknown as Data['showDemandSlots'][number];
const si = (show_id: string, item_id: number, zone = '') => ({ show_id, item_id, lamp_id: null, zone }) as unknown as Data['showItems'][number];
const base = (o: Partial<Data>): Data => ({ ...EMPTY_DATA, shows: [prev, cur], ...o }) as Data;

// reste à préparer : face → 3e, plateau → dessous ; les projecteurs encore montés au précédent ne comptent pas comme stock
let d = base({ items: [it(1, 'M', true), it(2, 'M', false), it(3, 'M', false), it(4, 'M', false)], showItems: [si('prev', 4)], showDemands: [dem('d1', 'M', 3)],
  showDemandSlots: [sl('d1', 'plateau', 2), sl('d1', 'face', 1)] });
let r = remainingNeeds(d, cur);
assert.deepEqual(r.prep.map((x) => [x.zone, x.from, x.n, x.fallback]), [['plateau', 'dessous', 2, false], ['face', 'stock3', 1, false]]);
assert.equal(r.unavailable.length, 0);
// les déjà affectés réduisent le besoin de leur zone ; plus de 3e → repli sur les dessous
d = base({ items: [it(1, 'M', false), it(2, 'M', false), it(3, 'M', false)], showItems: [si('cur', 3, 'plateau')], showDemands: [dem('d1', 'M', 3)],
  showDemandSlots: [sl('d1', 'plateau', 2), sl('d1', 'face', 1)] });
r = remainingNeeds(d, cur);
assert.deepEqual(r.prep.map((x) => [x.zone, x.from, x.n, x.fallback]), [['plateau', 'dessous', 1, false], ['face', 'dessous', 1, true]]);
// introuvable
d = base({ items: [it(1, 'M', false)], showDemands: [dem('d1', 'M', 2)] });
r = remainingNeeds(d, cur); assert.equal(r.unavailable[0].n, 1); assert.equal(r.prep[0].n, 1);

// scan : zone selon l'origine ; question si le besoin n'existe que dans l'autre zone ; sans zone précise = pas de question
d = base({ items: [it(1, 'M', true), it(2, 'M', false)], showDemands: [dem('d1', 'M', 2)], showDemandSlots: [sl('d1', 'plateau', 1), sl('d1', 'face', 1)] });
let t = prepScanTarget(d, cur, 1); assert.ok(t.ok && t.zone === 'face' && t.ask === '');      // pastille bleue → face
t = prepScanTarget(d, cur, 2); assert.ok(t.ok && t.zone === 'plateau' && t.ask === '');
d = base({ items: [it(1, 'M', true)], showDemands: [dem('d1', 'M', 1)], showDemandSlots: [sl('d1', 'plateau', 1)] });
t = prepScanTarget(d, cur, 1); assert.ok(t.ok && t.zone === 'plateau' && t.ask.includes('3e'));   // 3e mais besoin au plateau : on demande
d = base({ items: [it(1, 'M', true)], showDemands: [dem('d1', 'M', 1)] });
t = prepScanTarget(d, cur, 1); assert.ok(t.ok && t.zone === '' && t.ask === '');
// refus : inconnu, déjà affecté, demande complète, autre modèle
assert.equal(prepScanTarget(d, cur, 9).ok, false);
d = base({ items: [it(1, 'M', false), it(2, 'M', false)], showItems: [si('cur', 1)], showDemands: [dem('d1', 'M', 1)] });
assert.equal(prepScanTarget(d, cur, 1).ok, false); assert.equal(prepScanTarget(d, cur, 2).ok, false);
d = base({ items: [it(1, 'X', false)], showDemands: [dem('d1', 'M', 1)] }); assert.equal(prepScanTarget(d, cur, 1).ok, false);
// PAR : la ligne à la lampe du projecteur d'abord, sinon à relamper
d = base({ items: [it(1, 'P', false, 'A')], showDemands: [dem('d1', 'P', 1, 'B'), dem('d2', 'P', 1, 'A')] });
t = prepScanTarget(d, cur, 1); assert.ok(t.ok && t.demandId === 'd2' && !t.relamp && t.lamp === 'A');
d = base({ items: [it(1, 'P', false, 'A')], showDemands: [dem('d1', 'P', 1, 'B')] });
t = prepScanTarget(d, cur, 1); assert.ok(t.ok && t.relamp && t.lamp === 'B');
console.log('prep-needs OK');
