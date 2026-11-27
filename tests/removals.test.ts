import assert from 'node:assert/strict';
import { removalBanners } from '../src/removals';
import { EMPTY_DATA, type Data } from '../src/types';

// Spectacle B à venir : 3 PAR64 demandés, X (n° 1) retiré pour panne. Aujourd'hui = 2026-11-27.
const base = (): Data => ({
  ...EMPTY_DATA,
  models: [{ id: 'm', name: 'PAR64' }] as Data['models'],
  items: [1, 2, 3, 4].map((id) => ({ id, model_id: 'm' })) as Data['items'],
  shows: [{ id: 'B', name: 'B', start_date: '2026-12-05', end_date: '2026-12-09' }] as Data['shows'],
  showDemands: [{ id: 'd', show_id: 'B', model_id: 'm', lamp_id: null, qty: 3, missing: 0 }] as Data['showDemands'],
  showItems: [2, 3].map((n) => ({ show_id: 'B', item_id: n, lamp_id: null })) as Data['showItems'],
  showRemovals: [{ id: 'r', show_id: 'B', item_id: 1, model_id: 'm', lamp_id: null, zone: 'face', reason: 'en panne', kept: false, was_complete: true, created_at: '2026-11-27T07:00:00Z', push_sent_at: null }]
});
const T = '2026-11-27';

// trou ouvert : 2 affectés pour 3 demandés → bandeau fort (le spectacle était complet)
let b = removalBanners(base(), 'B', T);
assert.equal(b.length, 1); assert.equal(b[0].strong, true); assert.match(b[0].text, /N° 1 \(PAR64\) retiré du spectacle : en panne\. Il manque 1 × PAR64 à affecter \(il était prévu pour la face\)/);
// trou comblé par un autre projecteur → plus de bandeau
let d = base(); d.showItems.push({ show_id: 'B', item_id: 4, lamp_id: null } as Data['showItems'][number]); assert.equal(removalBanners(d, 'B', T).length, 0);
// un projecteur affecté mais indisponible ne comble pas le trou
d = base(); d.showItems.push({ show_id: 'B', item_id: 4, lamp_id: null, problem: 'SAV' } as Data['showItems'][number]); assert.equal(removalBanners(d, 'B', T).length, 1);
// réaffecté à la main (X revient) → plus de bandeau
d = base(); d.showItems.push({ show_id: 'B', item_id: 1, lamp_id: null } as Data['showItems'][number]); assert.equal(removalBanners(d, 'B', T).length, 0);
// loué / prêté : la part couverte réduit le besoin
d = base(); d.showExternals = [{ id: 'e', show_id: 'B', demand_id: 'd', kind: 'location', provider: 'X', qty: 1 }] as Data['showExternals']; assert.equal(removalBanners(d, 'B', T).length, 0);
// spectacle qui n'était pas complet : bandeau normal
d = base(); d.showRemovals[0].was_complete = false; assert.equal(removalBanners(d, 'B', T)[0].strong, false);
// spectacle commencé : aucun bandeau
assert.equal(removalBanners(base(), 'B', '2026-12-05').length, 0);
// projecteur gardé car déjà patché : bandeau tant qu'il est indisponible
d = base(); d.showRemovals[0].kept = true; d.showItems.push({ show_id: 'B', item_id: 1, lamp_id: null, problem: 'en panne' } as Data['showItems'][number]);
b = removalBanners(d, 'B', T); assert.equal(b.length, 1); assert.equal(b[0].kept, true); assert.match(b[0].text, /déjà patché/);
d.showItems.find((x) => x.item_id === 1)!.problem = null; assert.equal(removalBanners(d, 'B', T).length, 0);   // redevenu disponible
// autre spectacle : rien
assert.equal(removalBanners(base(), 'Z', T).length, 0);
console.log('removals OK');
