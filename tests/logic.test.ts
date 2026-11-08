import assert from 'node:assert/strict';
import { todayStr, addDays, applyPending, barSpan, counts, currentImmo, dayOf, immoState, isTransient, parseScan } from '../src/logic';
import { EMPTY_DATA } from '../src/types';
import type { Data, Immo, Op } from '../src/types';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok -', name); };

t('parseScan : numéro simple, URL, espaces', () => {
  assert.equal(parseScan('132'), 132);
  assert.equal(parseScan('  48\n'), 48);
  assert.equal(parseScan('https://thymori.github.io/stock-bdn/#/item/245'), 245);
  assert.equal(parseScan('https://x.y/app?id=7'), 7);
  assert.equal(parseScan('0'), 0);
});
t('parseScan : contenus non reconnus', () => {
  assert.equal(parseScan('hello'), null);
  assert.equal(parseScan(''), null);
  assert.equal(parseScan('1234567'), null);
  assert.equal(parseScan('https://x.y/#/item/12abc'), 12);
});

const base: Data = {
  ...EMPTY_DATA,
  items: [
    { id: 1, model_id: 'm', lamp_id: null, status: 'dispo', status_at: '2026-01-01T00:00:00Z', last_service: null, note: null },
    { id: 2, model_id: 'm', lamp_id: null, status: 'sav', status_at: '2026-01-01T00:00:00Z', last_service: null, note: null }
  ],
  faults: [{ id: 'f1', item_id: 2, description: 'x', reported_by_label: 'a', reported_at: '2026-01-01T00:00:00Z', resolved_at: null, resolution: null }]
};

t('applyPending : changement d\'état hors ligne visible tout de suite', () => {
  const ops: Op[] = [{ id: 'a', kind: 'status', item: 1, status: 'en_pret', at: '2026-02-01T00:00:00Z' }];
  const v = applyPending(base, ops);
  assert.equal(v.items[0].status, 'en_pret');
  assert.equal(v.items[0].pending, true);
  assert.equal(base.items[0].status, 'dispo', 'les données serveur ne sont pas modifiées');
});
t('applyPending : la dernière action gagne, une action plus ancienne que le serveur est ignorée', () => {
  const ops: Op[] = [
    { id: 'a', kind: 'status', item: 1, status: 'sav', at: '2026-02-01T00:00:00Z' },
    { id: 'b', kind: 'status', item: 1, status: 'en_pret', at: '2026-02-02T00:00:00Z' },
    { id: 'c', kind: 'status', item: 2, status: 'dispo', at: '2025-12-01T00:00:00Z' }
  ];
  const v = applyPending(base, ops);
  assert.equal(v.items[0].status, 'en_pret');
  assert.equal(v.items[1].status, 'sav');
});
t('applyPending : panne signalée puis résolue hors ligne, sans doublon une fois synchronisée', () => {
  const ops: Op[] = [
    { id: 'p1', kind: 'fault', item: 1, description: 'ampoule', at: '2026-02-01T00:00:00Z' },
    { id: 'r1', kind: 'resolve', fault: 'f1', resolution: 'changé', at: '2026-02-01T01:00:00Z' }
  ];
  const v = applyPending(base, ops);
  assert.equal(v.faults.length, 2);
  assert.equal(v.faults.find((f) => f.id === 'f1')!.resolved_at, '2026-02-01T01:00:00Z');
  const synced = applyPending({ ...base, faults: [...base.faults, { ...v.faults[0], pending: false }] }, [ops[0]]);
  assert.equal(synced.faults.filter((f) => f.id === 'p1').length, 1);
});
t('applyPending : info ajoutée et description modifiée hors ligne, avec l\'ancien texte conservé', () => {
  const ops: Op[] = [
    { id: 'n1', kind: 'fault_note', fault: 'f1', text: 'vu en répétition', at: '2026-02-01T00:00:00Z' },
    { id: 'e1', kind: 'fault_edit', fault: 'f1', description: 'x (corrigé)', at: '2026-02-01T00:05:00Z' }
  ];
  const v = applyPending(base, ops);
  assert.equal(v.faults[0].description, 'x (corrigé)');
  assert.deepEqual(v.faultLog.map((l) => [l.kind, l.text, l.old_text]), [['note', 'vu en répétition', null], ['edit', 'x (corrigé)', 'x']]);
  assert.equal(base.faults[0].description, 'x', 'les données serveur ne sont pas modifiées');
  const synced = applyPending({ ...base, faultLog: [{ id: 'n1', fault_id: 'f1', kind: 'note', text: 'vu en répétition', old_text: null, by_label: 'a', at: '2026-02-01T00:00:00Z' }] }, [ops[0]]);
  assert.equal(synced.faultLog.length, 1, 'pas de doublon une fois synchronisée');
});

const im = (o: Partial<Immo>): Immo => ({ id: 'i', item_id: 1, kind: 'pret', who: null, note: null, start_date: '2026-11-10', end_date: null, closed_date: null, ...o });
t('agenda : état d\'une période (à venir, en cours, en retard, terminée)', () => {
  const today = '2026-11-20';
  assert.equal(immoState(im({ start_date: '2026-12-01' }), today), 'planned');
  assert.equal(immoState(im({ start_date: '2026-11-10', end_date: '2026-11-25' }), today), 'running');
  assert.equal(immoState(im({ start_date: '2026-11-10' }), today), 'running', 'sans fin connue = en cours');
  assert.equal(immoState(im({ start_date: '2026-11-01', end_date: '2026-11-15' }), today), 'late');
  assert.equal(immoState(im({ start_date: '2026-11-01', end_date: '2026-11-15', closed_date: '2026-11-18' }), today), 'done');
});
t('agenda : position des barres dans la fenêtre', () => {
  const w = ['2026-10-01', '2026-10-31'] as const; // 31 jours
  const b = barSpan(im({ start_date: '2026-10-11', end_date: '2026-10-20' }), ...w)!;
  assert.ok(Math.abs(b.left - (10 / 31) * 100) < 1e-9 && Math.abs(b.width - (10 / 31) * 100) < 1e-9 && !b.openEnd);
  assert.equal(barSpan(im({ start_date: '2026-11-05', end_date: '2026-11-08' }), ...w), null, 'hors fenêtre');
  const open = barSpan(im({ start_date: '2026-10-25' }), ...w)!;
  assert.ok(open.openEnd && Math.abs(open.left + open.width - 100) < 1e-9, 'sans fin : se prolonge jusqu\'au bord');
  const clip = barSpan(im({ start_date: '2026-09-20', end_date: '2026-10-05' }), ...w)!;
  assert.ok(clip.clippedStart && clip.left === 0);
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
});
t('applyPending : prêt hors ligne = période ouverte avec emprunteur ; retour = clôture', () => {
  const today = dayOf(new Date().toISOString());
  const data: Data = { ...base, items: [{ ...base.items[0], id: 1, status: 'dispo', status_at: '2000-01-01T00:00:00Z' }], immos: [] };
  const at = new Date().toISOString();
  const lent = applyPending(data, [{ id: 's1', kind: 'status', item: 1, status: 'en_pret', who: 'Odéon', until: addDays(today, 7), at }]);
  assert.equal(lent.items[0].status, 'en_pret');
  assert.deepEqual([lent.immos.length, lent.immos[0].who, lent.immos[0].kind, lent.immos[0].start_date, lent.immos[0].closed_date], [1, 'Odéon', 'pret', today, null]);
  assert.equal(currentImmo(lent.immos, 1, today)?.who, 'Odéon');
  const back = applyPending(data, [{ id: 's1', kind: 'status', item: 1, status: 'en_pret', who: 'Odéon', at }, { id: 's2', kind: 'status', item: 1, status: 'sav', note: 'lentille', at: new Date(Date.now() + 1000).toISOString() }]);
  assert.deepEqual(back.immos.map((m) => [m.kind, m.closed_date]), [['pret', today], ['sav', null]], 'le prêt est clôturé, le SAV s\'ouvre');
  assert.equal(data.immos.length, 0, 'les données serveur ne sont pas modifiées');
});

t('isTransient : réseau => réessayer ; erreur métier => rejeter', () => {
  assert.equal(isTransient({ message: 'TypeError: Failed to fetch', code: '' }), true);
  assert.equal(isTransient({ message: 'JWT expired', code: 'PGRST301' }), true);
  assert.equal(isTransient({ message: 'Droits insuffisants', code: '42501' }), false);
  assert.equal(isTransient({ message: 'Projecteur 9 introuvable', code: 'P0002' }), false);
  assert.equal(isTransient(null), false);
});
t('counts', () => {
  assert.deepEqual(counts(base.items), { total: 2, dispo: 1, utilise: 0, sav: 1, en_pret: 0 });
});

const today = todayStr();
const withShows = (start: string, end: string): Data => ({ ...base,
  shows: [{ id: 's1', name: 'Hamlet', start_date: start, end_date: end, note: null }],
  showItems: [{ show_id: 's1', item_id: 1, lamp_id: null }, { show_id: 's1', item_id: 2, lamp_id: null }] });
t('spectacle en cours : dispo → utilisé, SAV reste SAV', () => {
  const v = applyPending(withShows(addDays(today, -1), addDays(today, 1)), []);
  assert.equal(v.items[0].eff, 'utilise');
  assert.equal(v.items[1].eff, 'sav');
  assert.deepEqual(counts(v.items), { total: 2, dispo: 0, utilise: 1, sav: 1, en_pret: 0 });
});
t('spectacle à venir ou terminé : pas utilisé, mais présent dans l\'agenda', () => {
  for (const [a, b] of [[addDays(today, 3), addDays(today, 5)], [addDays(today, -9), addDays(today, -5)]] as const) {
    const v = applyPending(withShows(a, b), []);
    assert.equal(v.items[0].eff, 'dispo');
    const sh = v.immos.filter((m) => m.kind === 'show' && m.item_id === 1);
    assert.equal(sh.length, 1);
    assert.equal(currentImmo(v.immos, 1, today), undefined, 'un spectacle n\'est pas une immobilisation en cours');
  }
});
t('spectacle : identifiants d\'agenda uniques par projecteur', () => {
  const v = applyPending(withShows(today, today), []);
  assert.equal(new Set(v.immos.map((m) => m.id)).size, v.immos.length);
});
t('changement de lampe en attente visible immédiatement', () => {
  const v = applyPending(base, [{ id: 'o1', kind: 'lamp', item: 1, lamp: 'l62', at: new Date().toISOString() }]);
  assert.equal(v.items[0].lamp_id, 'l62');
  assert.equal(v.items[0].pending, true);
  assert.equal(base.items[0].lamp_id === 'l62', false, 'données d\'origine intactes');
});
console.log(`\n${n} tests OK`);
