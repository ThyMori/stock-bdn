import assert from 'node:assert/strict';
import { applyPending, counts, isTransient, parseScan } from '../src/logic';
import { EMPTY_DATA } from '../src/types';
import type { Data, Op } from '../src/types';

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

t('isTransient : réseau => réessayer ; erreur métier => rejeter', () => {
  assert.equal(isTransient({ message: 'TypeError: Failed to fetch', code: '' }), true);
  assert.equal(isTransient({ message: 'JWT expired', code: 'PGRST301' }), true);
  assert.equal(isTransient({ message: 'Droits insuffisants', code: '42501' }), false);
  assert.equal(isTransient({ message: 'Projecteur 9 introuvable', code: 'P0002' }), false);
  assert.equal(isTransient(null), false);
});
t('counts', () => {
  assert.deepEqual(counts(base.items), { total: 2, dispo: 1, sav: 1, en_pret: 0 });
});
console.log(`\n${n} tests OK`);
