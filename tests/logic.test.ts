import assert from 'node:assert/strict';
import { fromEditable, toEditable, mentionedIds, mentionedItems, renderBody, personColor } from '../src/wall';
import { prepRows, gelGroups, gelsByRef, externalRows, prepSections, holderRows } from '../src/prepPdf';
import { splitGelRefs } from '../src/gels';
import { gelColorOf } from '../src/gels';
import { compareShows, teardownPlan } from '../src/teardown';
import { showAlerts, alertText, blockedReason, calendarExternals } from '../src/alerts';
import { todayStr, addDays, applyPending, barSpan, counts, currentImmo, dayOf, immoState, isTransient, parseScan, sortShows, isShowOver } from '../src/logic';
import { EMPTY_DATA } from '../src/types';
import { rollingStart } from '../src/views/calendar';
import { dayWindow } from '../src/views/agenda';
import type { Data, Immo, Op } from '../src/types';
import { buildRows, sortRows, editableCols, dmxRank, externalStatus, extCount, POSITIONS, POSITION_GROUPS, stateText } from '../src/patch';
import type { PatchRow } from '../src/patch';
import { positionGroups, accessoryList } from '../src/patchLists';
import { rankStock, similarNames } from '../src/patchSuggest';
import { clampW, cleanWidths, colCss, MIN_W, MAX_W } from '../src/patchCols';
import { noise, wobblePoints } from '../src/handwriting';
import { showMounted, positionNow, positionBefore, previousShow, positionTier, posLabel, isHang, isHigh } from '../src/position';

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
const people = [{ id: '11111111-1111-1111-1111-111111111111', label: 'Marie Durand' }, { id: '22222222-2222-2222-2222-222222222222', label: 'Marie' }];
t('mur : citations personne / projecteur', () => {
  const stored = fromEditable('Salut @Marie Durand, refocus #12 demain', people);
  assert.equal(stored, 'Salut @[Marie Durand](u:11111111-1111-1111-1111-111111111111), refocus #12 demain');
  assert.equal(toEditable(stored), 'Salut @Marie Durand, refocus #12 demain');
  assert.deepEqual(mentionedIds(stored), ['11111111-1111-1111-1111-111111111111']);
  assert.deepEqual(mentionedItems(stored), [12]);
  assert.equal(fromEditable('@Marie ok', people), '@[Marie](u:22222222-2222-2222-2222-222222222222) ok', 'le nom le plus long gagne, sans confusion');
});
t('mur : rendu HTML sûr', () => {
  const h = renderBody('<img src=x onerror=alert(1)> #219 &amp; @[Marie](u:11111111-1111-1111-1111-111111111111)');
  assert.ok(!h.includes('<img'), 'html échappé');
  assert.ok(h.includes('href="#/item/219"'));
  assert.ok(h.includes('class="mention"'));
});
t('mur : couleur stable par personne', () => {
  assert.equal(personColor('abc'), personColor('abc'));
  assert.match(personColor('abc'), /^#[0-9a-f]{6}$/);
});
t('liste de prépa : tri par type, lampe requise pour les PAR', () => {
  const d = { ...EMPTY_DATA,
    types: [{ id: 'tp', name: 'PAR' }, { id: 'td', name: 'découpe' }], lamps: [{ id: 'l62', name: 'CP62' }, { id: 'l60', name: 'CP60' }],
    models: [{ id: 'mp', name: 'PAR64', type_id: 'tp' }, { id: 'md', name: '614 SX', type_id: 'td' }],
    items: [{ id: 5, model_id: 'mp', lamp_id: 'l60', status: 'dispo' }, { id: 2, model_id: 'md', lamp_id: null, status: 'sav' }],
    showItems: [{ show_id: 's', item_id: 5, lamp_id: 'l62' }, { show_id: 's', item_id: 2, lamp_id: null }, { show_id: 'autre', item_id: 5, lamp_id: null }] } as unknown as Data;
  const r = prepRows(d, 's');
  assert.deepEqual(r.map((x) => [x.type, x.id, x.lamp, x.current, x.sav]), [['découpe', 2, '', '', true], ['PAR', 5, 'CP62', 'CP60', false]]);
});
t('gélatines : sections par format de projecteur, modèles à même porte-filtre regroupés', () => {
  const d = { ...EMPTY_DATA, filterSizes: [{ id: 'f', label: '255 x 255' }], types: [],
    models: [{ id: 'a', name: '613 SX', type_id: null, filter_size_id: 'f' }, { id: 'b', name: '614 SX', type_id: null, filter_size_id: 'f' }, { id: 'c', name: 'PAR64', type_id: null, filter_size_id: null }],
    items: [{ id: 1, model_id: 'a' }, { id: 2, model_id: 'b' }, { id: 3, model_id: 'c' }],
    showGels: [
      { id: '1', show_id: 's', item_id: 1, ref: 'L201', color: 'Correction (CTO/CTB)' },
      { id: '2', show_id: 's', item_id: 2, ref: 'l201', color: 'Correction (CTO/CTB)' },
      { id: '3', show_id: 's', item_id: 2, ref: 'R26', color: 'Rouge' },
      { id: '4', show_id: 's', item_id: 3, ref: 'L106', color: 'Rouge' },
      { id: '5', show_id: 'autre', item_id: 3, ref: 'L106', color: 'Rouge' }] } as unknown as Data;
  const g = gelGroups(d, 's');
  assert.deepEqual(g.map((x) => [x.title, x.ref, x.qty]), [['613 SX / 614 SX', 'L201', 2], ['613 SX / 614 SX', 'R26', 1], ['PAR64', 'L106', 1]]);
});
t('gélatines : classées par référence (Lee avant Rosco, puis par numéro)', () => {
  const mk = (ref: string) => ({ show_id: 's', item_id: 1, ref, color: 'Bleu' });
  const d = { shows: [], items: [{ id: 1, model_id: 'm' }], models: [{ id: 'm', name: 'PAR64' }], types: [], families: [], lamps: [], sockets: [], filterSizes: [], patchLines: [], showGels: ['R80', 'L201', 'LEE 106', '#26', 'L20', 'Rosco 3202'].map(mk) } as unknown as Data;
  assert.deepEqual(gelGroups(d, 's').map((x) => x.ref), ['L20', 'LEE 106', 'L201', '#26', 'R80', 'Rosco 3202']);
});
t('gélatines à couper : d\'abord par référence, puis par format', () => {
  const g = (item: number, ref: string) => ({ show_id: 's', item_id: item, ref, color: ref.startsWith('R') ? 'Bleu' : 'Rouge' });
  const d = { shows: [], items: [{ id: 1, model_id: 'a' }, { id: 2, model_id: 'b' }, { id: 3, model_id: 'a' }], models: [{ id: 'a', name: 'PAR64' }, { id: 'b', name: '614 SX' }], types: [], families: [], lamps: [], sockets: [], filterSizes: [], patchLines: [],
    showGels: [g(1, 'R80'), g(2, 'L106'), g(3, 'L106'), g(1, 'L106'), g(2, 'R80')] } as unknown as Data;
  const r = gelsByRef(d, 's');
  assert.deepEqual(r.map((x) => [x.ref, x.total]), [['L106', 3], ['R80', 2]], 'une entrée par référence, Lee avant Rosco');
  assert.deepEqual(r[0].rows.map((x) => [x.title, x.qty]), [['614 SX', 1], ['PAR64', 2]], 'sous chaque référence : les modèles');
});
t('gélatines : couleur déduite de la référence (Lee / Rosco)', () => {
  assert.equal(gelColorOf('L201'), 'Correction (CTO/CTB)');
  assert.equal(gelColorOf('LEE 106'), 'Rouge');
  assert.equal(gelColorOf('R80'), 'Bleu');
  assert.equal(gelColorOf('#26'), 'Rouge');
  assert.equal(gelColorOf('Rosco 3202'), 'Correction (CTO/CTB)');
  assert.equal(gelColorOf('119'), 'Bleu');
  assert.equal(gelColorOf('machin'), 'Autre');
});
t('démontage : à préparer / conserver / ranger, changement de lampe des PAR', () => {
  const d = { ...EMPTY_DATA,
    types: [{ id: 'tp', name: 'PAR' }, { id: 'td', name: 'découpe' }], lamps: [{ id: 'l62', name: 'CP62' }, { id: 'l60', name: 'CP60' }],
    models: [{ id: 'mp', name: 'PAR64', type_id: 'tp' }, { id: 'md', name: '614 SX', type_id: 'td' }],
    items: [1, 2, 3, 4, 5].map((id) => ({ id, model_id: id === 4 ? 'md' : 'mp', lamp_id: 'l60', status: 'dispo' })),
    showItems: [
      { show_id: 'a', item_id: 1, lamp_id: 'l60' }, { show_id: 'a', item_id: 2, lamp_id: 'l60' }, { show_id: 'a', item_id: 3, lamp_id: 'l60' }, { show_id: 'a', item_id: 4, lamp_id: null },
      { show_id: 'b', item_id: 1, lamp_id: 'l62' }, { show_id: 'b', item_id: 2, lamp_id: 'l60' }, { show_id: 'b', item_id: 5, lamp_id: 'l62' }, { show_id: 'b', item_id: 3, lamp_id: null }] } as unknown as Data;
  const r = compareShows(d, 'a', 'b');
  assert.deepEqual(r.prepare.map((x) => x.id), [5]);
  assert.deepEqual(r.keep.map((x) => [x.id, x.from, x.to, x.change, x.toUnknown]), [[1, 'CP60', 'CP62', true, false], [2, 'CP60', 'CP60', false, false], [3, 'CP60', '', false, true]]);
  assert.deepEqual(r.store.map((x) => x.id), [4]);
});
t('alertes matériel : demandes non satisfaites et projecteurs indisponibles, spectacles à venir seulement', () => {
  const d = { ...EMPTY_DATA, models: [{ id: 'm', name: 'PAR64' }], lamps: [{ id: 'l', name: 'CP62' }],
    shows: [{ id: 'a', name: 'A', start_date: '2026-11-10', end_date: '2026-11-12' }, { id: 'b', name: 'B', start_date: '2026-01-01', end_date: '2026-01-02' }, { id: 'c', name: 'C', start_date: '2026-11-20', end_date: '2026-11-22' }],
    showDemands: [{ id: '1', show_id: 'a', model_id: 'm', lamp_id: 'l', qty: 4, missing: 2 }, { id: '2', show_id: 'b', model_id: 'm', lamp_id: null, qty: 1, missing: 1 }, { id: '3', show_id: 'c', model_id: 'm', lamp_id: null, qty: 1, missing: 0 }],
    showItems: [{ show_id: 'c', item_id: 7, lamp_id: null, problem: 'SAV' }] } as unknown as Data;
  const a = showAlerts(d, '2026-11-09');
  assert.deepEqual(a.map((x) => x.show.id), ['a', 'c']);
  assert.equal(alertText(a[0]), 'il manque 2 × PAR64 CP62');
  assert.equal(alertText(a[1]), '1 projecteur indisponible');
});
t('projecteur indisponible pour un spectacle : autre spectacle, SAV / prêt, panne', () => {
  const show = { id: 'a', name: 'A', start_date: '2026-11-10', end_date: '2026-11-12' } as unknown as Data['shows'][number];
  const d = { ...EMPTY_DATA, shows: [show, { id: 'b', name: 'B', start_date: '2026-11-11', end_date: '2026-11-15' }, { id: 'c', name: 'C', start_date: '2026-12-01', end_date: '2026-12-02' }],
    showItems: [{ show_id: 'b', item_id: 1 }, { show_id: 'c', item_id: 2 }],
    immos: [{ item_id: 3, kind: 'sav', start_date: '2026-11-01', end_date: null, closed_date: null }, { item_id: 4, kind: 'pret', start_date: '2026-11-01', end_date: '2026-11-05', closed_date: null }],
    faults: [{ item_id: 5, resolved_at: null }, { item_id: 6, resolved_at: '2026-11-01' }] } as unknown as Data;
  assert.equal(blockedReason(d, 1, show), 'déjà dans « B »');
  assert.equal(blockedReason(d, 2, show), null);
  assert.equal(blockedReason(d, 3, show), 'SAV');
  assert.equal(blockedReason(d, 4, show), null);
  assert.equal(blockedReason(d, 5, show), 'en panne');
  assert.equal(blockedReason(d, 6, show), null);
});
t('prêts / locations : libellé et rappel de calendrier', () => {
  const d = { ...EMPTY_DATA, models: [{ id: 'm', name: 'PAR64' }], lamps: [{ id: 'l', name: 'CP62' }],
    showDemands: [{ id: 'd', show_id: 's', model_id: 'm', lamp_id: 'l', qty: 4, missing: 0 }],
    showExternals: [{ id: 'e', show_id: 's', demand_id: 'd', kind: 'location', provider: 'Dushow', qty: 4, delivery_date: '2026-11-04', return_date: '2026-11-20' },
      { id: 'f', show_id: 's', demand_id: 'd', kind: 'pret', provider: 'Vidy', qty: 1, delivery_date: '2026-11-05', return_date: '2026-11-18' }] } as unknown as Data;
  const c = calendarExternals(d);
  assert.equal(c[0].label, '4 × PAR64 CP62 loués chez Dushow · jusqu\'au 20/11');
  assert.equal(c[1].label, '1 × PAR64 CP62 prêté par Vidy · jusqu\'au 18/11');
  assert.deepEqual([c[0].start, c[0].end], ['2026-11-04', '2026-11-20']);
});
t('agenda : fenêtre glissante de 20 jours (5 avant, aujourd\'hui, 14 après)', () => {
  const w = dayWindow('2026-11-22', 0);
  assert.deepEqual([w.from, w.to], ['2026-11-17', '2026-12-06']);
  assert.equal(addDays(w.to, 1) > w.to, true);
  assert.deepEqual(w.ticks.map((t) => t.label), ['17/11', '22/11', '27/11', '02/12']);
  const next = dayWindow('2026-11-22', 14);
  assert.deepEqual([next.from, next.to], ['2026-12-01', '2026-12-20']);
  assert.deepEqual([dayWindow('2026-03-01', 0).from, dayWindow('2026-01-03', 0).from], ['2026-02-24', '2025-12-29']);   // passage de mois et d'année
});

t('sortShows : à venir chronologique, terminés grisés en bas (le plus ancien en dernier)', () => {
  const S = (name: string, s: string, e: string) => ({ name, start_date: s, end_date: e });
  const r = sortShows([S('vieux', '2026-01-01', '2026-01-10'), S('loin', '2027-01-01', '2027-01-05'), S('récent', '2026-10-01', '2026-10-31'), S('prochain', '2026-12-01', '2026-12-05'), S('en cours', '2026-11-10', '2026-11-30')], '2026-11-22').map((x) => x.name);
  assert.deepEqual(r, ['en cours', 'prochain', 'loin', 'récent', 'vieux']);
  assert.ok(isShowOver(S('x', '2026-11-01', '2026-11-21'), '2026-11-22') && !isShowOver(S('x', '2026-11-01', '2026-11-22'), '2026-11-22'));
});
t('calendrier glissant : commence le lundi de la semaine passée', () => {
  assert.equal(rollingStart('2026-11-22'), '2026-11-09');   // dimanche 22/11 -> lundi 16/11 -> 1 semaine avant
  assert.equal(rollingStart('2026-11-16'), '2026-11-09');   // un lundi
  assert.equal(rollingStart('2026-01-03'), '2025-12-22');   // passage d'année
});
// --- Feuille de patch / focus ---
const prow = (o: Partial<PatchRow>): PatchRow => ({ key: 'k', lineId: null, itemId: null, circuit: '', dimmer: '', curve: ['lineaire'], dmx: '', model: '', gels: [], gelIds: [], auto: false, needId: null, externalId: null, extNote: '', modelId: null, lampId: null, par: false, accessories: [], position: '', focus: false, state: '', stateNote: '', notes: '', updatedAt: null, updatedBy: null, ...o });
t('patch : droits par colonne', () => {
  assert.deepEqual([...editableCols(false, true)].sort(), ['curve', 'dimmer', 'gels']);   // technicien
  assert.equal(editableCols(false, false).size, 0);                                // lecture seule
  assert.ok(editableCols(true, true).has('position') && editableCols(true, true).has('id') && editableCols(true, true).has('gels'));
});
t('patch : tri naturel, vides en dernier, égalité par ID', () => {
  const rows = [prow({ key: 'a', itemId: 3, circuit: '10' }), prow({ key: 'b', itemId: 1, circuit: '' }), prow({ key: 'c', itemId: 2, circuit: '2' })];
  assert.deepEqual(sortRows(rows, 'circuit', 1).map((r) => r.key), ['c', 'a', 'b']);
  assert.deepEqual(sortRows(rows, 'circuit', -1).map((r) => r.key), ['a', 'c', 'b']);   // le vide reste dernier
  assert.deepEqual(sortRows(rows, 'id', -1).map((r) => r.key), ['a', 'c', 'b']);
});
t('patch : adresse DMX comparée univers puis adresse', () => {
  assert.ok(dmxRank('1-200') < dmxRank('2-5'));
  assert.equal(dmxRank(''), Infinity);
});
t('patch : buildRows sans projecteur ni ligne = vide', () => {
  assert.deepEqual(buildRows(EMPTY_DATA, 's1', []), []);
});
t('patch : une ligne sans projecteur porte ses gélatines', () => {
  const line = { id: 'L1', show_id: 's1', item_id: null, circuit: '3', dimmer: '', curve: ['lineaire'], dmx: '', model_text: 'Découpe louée', accessories: [], position: '', focus: false, notes: '', updated_at: '2026-11-22T10:00:00Z', updated_by_label: 'X', gels: [{ ref: 'R80', color: 'Bleu' }, { ref: 'L201', color: 'Correction (CTO/CTB)' }] };
  const rows = buildRows(EMPTY_DATA, 's1', [line]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].gels, ['R80', 'L201']);
  assert.deepEqual(rows[0].gelIds, ['R80', 'L201']);   // retrait par référence
  assert.equal(rows[0].itemId, null);
});
// --- Position des projecteurs et mode prépa ---
t('position : spectacle monté (interrupteur, en cours figé, démontage automatique)', () => {
  const sh = (o: object) => ({ id: 's', name: 'S', start_date: '2026-11-10', end_date: '2026-11-15', note: null, ...o }) as Data['shows'][0];
  assert.equal(showMounted(sh({}), '2026-11-12'), true, 'en cours = monté, même sans interrupteur');
  assert.equal(showMounted(sh({ mounted: false }), '2026-11-12'), true, 'en cours : figé monté');
  assert.equal(showMounted(sh({}), '2026-11-05'), false, 'avant : selon l\'interrupteur');
  assert.equal(showMounted(sh({ mounted: true, mounted_at: '2026-11-05T10:00:00' }), '2026-11-05'), true, 'forcé monté avant');
  assert.equal(showMounted(sh({ mounted: true, mounted_at: '2026-11-05T10:00:00' }), '2026-11-16'), false, 'le lendemain du dernier jour : démonté tout seul');
  assert.equal(showMounted(sh({ mounted: true, mounted_at: '2026-11-17T10:00:00' }), '2026-11-18'), true, 'forcé monté après : reste monté');
});
const posData = (): Data => ({ ...EMPTY_DATA,
  types: [{ id: 't-par', name: 'PAR' }, { id: 't-dec', name: 'Découpe' }],
  models: [{ id: 'm-par', name: 'PAR64', type_id: 't-par' }, { id: 'm-a', name: '614SX', type_id: 't-dec' }, { id: 'm-b', name: '614S', type_id: 't-dec' }, { id: 'm-c', name: '713', type_id: 't-dec' }] as Data['models'],
  lamps: [{ id: 'l1', name: 'CP60' }, { id: 'l2', name: 'CP62' }] as Data['lamps'],
  items: [
    { id: 1, model_id: 'm-par', lamp_id: 'l2', status: 'dispo' }, { id: 2, model_id: 'm-par', lamp_id: 'l1', status: 'dispo' },
    { id: 3, model_id: 'm-a', lamp_id: null, status: 'dispo' }, { id: 4, model_id: 'm-b', lamp_id: null, status: 'dispo', blue_dot: true }, { id: 5, model_id: 'm-a', lamp_id: null, status: 'dispo', blue_dot: true },
    { id: 6, model_id: 'm-a', lamp_id: null, status: 'dispo' }
  ] as unknown as Data['items'],
  shows: [{ id: 'sA', name: 'Avant', start_date: '2026-06-01', end_date: '2026-06-10' }, { id: 'sB', name: 'Courant', start_date: '2026-12-01', end_date: '2026-12-05' }] as Data['shows'],
  showItems: [{ show_id: 'sA', item_id: 3 }, { show_id: 'sA', item_id: 6 }] as unknown as Data['showItems'],
  patchLines: [{ id: 'a', show_id: 'sA', item_id: 3, position: 'P2' }, { id: 'b', show_id: 'sA', item_id: 6, position: '3e balcon' }] as unknown as Data['patchLines'] });
t('position : actuelle et au moment de préparer un spectacle', () => {
  const d = posData();
  assert.equal(posLabel(positionNow(d, 3, '2026-06-05')), 'P2 (Avant)', 'spectacle en cours : position de la feuille');
  assert.equal(posLabel(positionNow(d, 3, '2026-11-22')), 'stock dessous', 'spectacle démonté : stock');
  assert.equal(posLabel(positionNow(d, 4, '2026-11-22')), 'stock 3e', 'pastille bleue : stock 3e');
  assert.equal(posLabel(positionNow({ ...d, immos: [{ id: 'i', item_id: 1, kind: 'pret', start_date: '2026-11-01', end_date: null, closed_date: null }] as unknown as Data['immos'] }, 1, '2026-11-22')), 'PRÊT');
  assert.equal(previousShow(d, d.shows[1])?.id, 'sA');
  assert.equal(posLabel(positionBefore(d, 3, d.shows[1])), 'P2 (Avant)', 'juste avant : sa position dans le spectacle précédent');
  assert.equal(posLabel(positionBefore(d, 5, d.shows[1])), 'stock 3e');
});
t('position : préférences selon la position voulue', () => {
  const st3 = { kind: 'stock3', position: '', show: '' } as const, des = { kind: 'dessous', position: '', show: '' } as const, at = (p: string) => ({ kind: 'show', position: p, show: 'X' }) as const;
  assert.equal(positionTier(st3, '3e balcon').tier, 0); assert.equal(positionTier(st3, '2e balcon').tier, 0); assert.equal(positionTier(st3, 'coupole').tier, 0);
  assert.ok(positionTier(st3, 'P3').tier > positionTier(des, 'P3').tier, 'Px : dessous avant stock 3e');
  assert.equal(positionTier(at('P3'), 'P3').tier, 0, 'déjà à cette position');
  assert.equal(positionTier(at('2e balcon'), '3e balcon').tier, 1, 'autre position haute');
  assert.ok(positionTier(st3, 'corbeille').tier < positionTier(des, 'corbeille').tier, 'corbeille : stock 3e avant dessous');
  assert.equal(positionTier(des, '').tier, 0, 'pas de position voulue : aucun critère');
});
t('positions : groupes par zone, P0 présent, aucun doublon', () => {
  assert.deepEqual(POSITION_GROUPS.map((g) => g.label), ['Cintres', 'Cage de scène', 'FOH', 'Autres']);
  assert.ok(POSITIONS.includes('P0') && POSITIONS.includes('2e balcon') && POSITIONS.includes('3e balcon'));
  assert.ok(!POSITIONS.includes('balcon') && !POSITIONS.includes('3e'), 'anciens noms retirés');
  assert.equal(new Set(POSITIONS).size, POSITIONS.length);
});
t('PDF patch : zones > positions, accessoires par modèle', () => {
  const R = (o: Partial<PatchRow>): PatchRow => ({ key: String(Math.random()), lineId: null, itemId: 1, circuit: '', dimmer: '', curve: [], dmx: '', model: 'PC', gels: [], gelIds: [], auto: false, accessories: [], position: '', focus: false, state: '', stateNote: '', notes: '', updatedAt: null, updatedBy: null, needId: null, externalId: null, extNote: '', modelId: null, lampId: null, par: false, ...o });
  const rows = [R({ circuit: '10', position: 'sol', gels: ['L201', 'R80'], accessories: ['iris'] }), R({ circuit: '2', position: 'P3', gels: ['L201'], model: 'Découpe', accessories: ['iris', 'gobo'] }), R({ circuit: '5', position: '2e balcon' }), R({ circuit: '1', position: 'P0' }), R({ circuit: '7' })];
  const g = positionGroups(rows);
  assert.deepEqual(g.map((x) => [x.label, x.sub]), [['Cintres', 'P0'], ['Cintres', 'P3'], ['FOH', '2e balcon'], ['Autres', 'sol'], ['Sans position', '']], 'zone > position, dans l\'ordre, vides omises');
  const ids = positionGroups([R({ itemId: 9, position: 'P1' }), R({ itemId: null, circuit: '3', position: 'P1' }), R({ itemId: 2, position: 'P1' })])[0].rows.map((r) => r.itemId);
  assert.deepEqual(ids, [2, 9, null], 'classés par ID, N/C à la fin');
  const al = accessoryList(rows);
  assert.deepEqual(al.map((x) => [x.model, x.accessory, x.qty]), [['Découpe', 'Iris', 1], ['Découpe', 'Gobo', 1], ['PC', 'Iris', 1]], 'classés par modèle');
});
t('état des lignes : tri (à faire, fait, vide) et compte', () => {
  const rows = [prow({ key: 'a', itemId: 1, state: 'ok' }), prow({ key: 'b', itemId: 2 }), prow({ key: 'c', itemId: 3, state: 'todo', stateNote: 'x' }), prow({ key: 'd', itemId: 4, state: 'ok' })];
  assert.deepEqual(sortRows(rows, 'state', 1).map((r) => r.key), ['c', 'a', 'd', 'b'], 'à faire, puis fait, puis vide');
  assert.equal(stateText(rows), '2 faits · 1 à faire'); assert.equal(stateText([]), '0 fait · 0 à faire');
  const line = { id: 'L', show_id: 's', item_id: null, circuit: '', dimmer: '', curve: ['lineaire'], dmx: '', model_text: 'x', accessories: [], position: '', focus: true, notes: '', updated_at: '', updated_by_label: null } as unknown as Parameters<typeof buildRows>[2][number];
  assert.equal(buildRows(EMPTY_DATA, 's', [line])[0].state, 'ok', 'ancienne ligne focus=true : état vert');
});
t('prépa : modèles similaires', () => {
  assert.ok(similarNames('614SX', '614S') && similarNames('ETC 25-50', '613') && similarNames('329HPC', '329HPB') && similarNames('310HPC', '306HPC'));
  assert.ok(!similarNames('614SX', '713'));
});
t('prépa : classement modèle > position > lampe', () => {
  const d = posData(), show = d.shows[1];
  // ligne 614 SX à monter au 3e : même modèle d'abord ; déjà au 3e, stock 3e, puis le reste ; le modèle similaire passe après
  const r = rankStock(d, show, { modelId: 'm-a', lampId: null, par: false, position: '3e balcon' });
  assert.deepEqual(r.map((x) => [x.id, x.group]).slice(0, 4), [[6, 'same'], [5, 'same'], [3, 'same'], [4, 'similar']]);   // 6 : déjà au 3e ; 5 : stock 3e ; 3 : à P2
  // ligne PAR en P2 : la position (stock dessous) passe avant la lampe
  const p = rankStock(d, show, { modelId: 'm-par', lampId: 'l1', par: true, position: 'P2' });
  assert.deepEqual(p.slice(0, 2).map((x) => x.id), [2, 1], 'même position (dessous) : la lampe départage');
  const q = rankStock(d, show, { modelId: 'm-a', lampId: null, par: false, position: 'P2' });
  assert.deepEqual(q.slice(0, 3).map((x) => x.id), [3, 5, 6], 'P2 : déjà à P2, puis stock 3e, puis une autre position');
});
t('patch : lignes rattachées à une location, compteur informatif', () => {
  const d = { ...EMPTY_DATA, models: [{ id: 'm1', name: 'PAR64' }] as Data['models'], showDemands: [{ id: 'd1', show_id: 's1', model_id: 'm1', lamp_id: null, qty: 2, missing: 0 }] as Data['showDemands'],
    showExternals: [{ id: 'e1', show_id: 's1', demand_id: 'd1', kind: 'location', provider: 'Loueur', qty: 2, delivery_date: '2026-11-01', return_date: '2026-11-02' }] as Data['showExternals'] };
  const ln = (id: string, ext: string | null) => ({ id, show_id: 's1', item_id: null, circuit: '', dimmer: '', curve: ['lineaire'], dmx: '', model_text: '', accessories: [], position: '', focus: false, notes: '', updated_at: '', updated_by_label: null, external_id: ext });
  assert.equal(extCount(externalStatus(d, 's1', [ln('a', 'e1')])[0]), '1/2 · il en manque 1');
  assert.equal(extCount(externalStatus(d, 's1', [ln('a', 'e1'), ln('b', 'e1')])[0]), '2/2 ✓');
  assert.equal(extCount(externalStatus(d, 's1', [ln('a', 'e1'), ln('b', 'e1'), ln('c', 'e1')])[0]), '3/2 · 1 en trop');
  assert.equal(buildRows(d, 's1', [ln('a', 'e1')])[0].extNote, 'loué chez Loueur');
  assert.equal(buildRows({ ...d, showExternals: [] }, 's1', [ln('a', 'e1')])[0].extNote, '', 'location supprimée : plus de mention');
});
t('plan de démontage : stock dessous / 3e, en place, à déplacer, à monter avec provenance', () => {
  const sh = (id: string, a: string, b: string) => ({ id, name: id, start_date: a, end_date: b });
  const pl = (show: string, item: number, position: string) => ({ show_id: show, item_id: item, position, accessories: [] });
  const d = { ...EMPTY_DATA, models: [{ id: 'm', name: '614', type_id: null }] as Data['models'],
    items: [1, 2, 3, 4, 5, 6].map((id) => ({ id, model_id: 'm', lamp_id: null, status: 'dispo', blue_dot: id === 2 })) as unknown as Data['items'],
    shows: [sh('a', '2026-01-01', '2026-01-05'), sh('b', '2026-02-01', '2026-02-05')] as unknown as Data['shows'],
    showItems: [1, 2, 3, 4].map((i) => ({ show_id: 'a', item_id: i, lamp_id: null })).concat([3, 4, 5, 6].map((i) => ({ show_id: 'b', item_id: i, lamp_id: null }))) as unknown as Data['showItems'],
    patchLines: [pl('a', 1, 'P1'), pl('a', 2, '3e balcon'), pl('a', 3, 'P2'), pl('a', 4, 'P3'), pl('b', 3, 'P2'), pl('b', 4, '2e balcon'), pl('b', 5, '3e balcon'), pl('b', 6, 'P1')] as unknown as Data['patchLines'] } as Data;
  const p = teardownPlan(d, 'a', 'b');
  assert.deepEqual(p.dessous.map((r) => r.id), [1], 'sans pastille, absent du suivant : dessous');
  assert.deepEqual(p.stock3.map((r) => r.id), [2], 'pastille bleue : stock 3e');
  assert.deepEqual(p.keep.map((r) => r.id), [3], 'même position : reste en place');
  assert.deepEqual(p.move.map((r) => [r.id, r.oldPos, r.newPos]), [[4, 'P3', '2e balcon']]);
  assert.deepEqual(p.mount.map((r) => [r.id, r.origin]), [[5, 'stock dessous'], [6, 'stock dessous']], 'trié par position voulue');
});
t('liste de prépa : provenance, position et accessoires ; prêts et locations sans ID', () => {
  const sh = (id: string, a: string, b: string) => ({ id, name: id, start_date: a, end_date: b });
  const d = { ...EMPTY_DATA, models: [{ id: 'm', name: '614', type_id: null }] as Data['models'], lamps: [{ id: 'l', name: 'CP62' }] as Data['lamps'],
    items: [1, 2, 3].map((id) => ({ id, model_id: 'm', lamp_id: null, status: 'dispo', blue_dot: id === 2 })) as unknown as Data['items'],
    shows: [sh('a', '2026-01-01', '2026-01-05'), sh('b', '2026-02-01', '2026-02-05')] as unknown as Data['shows'],
    showItems: [{ show_id: 'a', item_id: 3, lamp_id: null }, ...[1, 2, 3].map((i) => ({ show_id: 'b', item_id: i, lamp_id: null }))] as unknown as Data['showItems'],
    patchLines: [{ show_id: 'a', item_id: 3, position: 'P2', accessories: [] }, { show_id: 'b', item_id: 1, position: 'P1', accessories: ['Volets'] }, { show_id: 'b', item_id: 9, position: '', accessories: ['Iris', 'Iris'], external_id: 'e1' }] as unknown as Data['patchLines'],
    showDemands: [{ id: 'd', show_id: 'b', model_id: 'm', lamp_id: 'l', qty: 2, missing: 0 }] as Data['showDemands'],
    showExternals: [{ id: 'e1', show_id: 'b', demand_id: 'd', kind: 'location', provider: 'X', qty: 2, delivery_date: '2026-01-30', return_date: '2026-02-06' }] as Data['showExternals'] } as Data;
  const r = prepRows(d, 'b');
  assert.deepEqual(r.map((x) => [x.id, x.origin]), [[1, 'dessous'], [2, 'stock3'], [3, 'monte']]);
  assert.deepEqual([r[0].position, r[0].accessories, r[2].from], ['P1', ['Volets'], 'P2 (a)']);
  const sec = prepSections(r);
  assert.deepEqual(sec.map((x) => x.title), ['À préparer', 'Présents sur le spectacle précédent'], 'les projecteurs du spectacle précédent sont à part');
  assert.deepEqual(sec[0].groups.flatMap((g) => g.rows.map((x) => [x.id, x.storage])), [[1, 'dessous'], [2, 'stock3']], 'à préparer : dessous avant stock 3e');
  assert.equal(sec[1].groups[0].rows[0].id, 3); assert.ok(['dessous', 'stock3'].includes(sec[1].groups[0].rows[0].storage), 'le stockage normal est précisé');
  const e = externalRows(d, 'b');
  assert.deepEqual([e[0].kind, e[0].text, e[0].accessories], ['location', '2 × 614 CP62 — loué chez X', ['2 × Iris']]);
});
t('position « pont coupole » : traitée comme « sol » (déjà là, puis dessous, puis stock 3e)', () => {
  const p = (kind: 'show' | 'dessous' | 'stock3', position = '') => ({ kind, position, show: '' }) as Parameters<typeof positionTier>[0];
  assert.deepEqual(positionTier(p('show', 'pont coupole'), 'pont coupole'), positionTier(p('show', 'sol'), 'sol'));
  assert.ok(positionTier(p('dessous'), 'pont coupole').tier < positionTier(p('stock3'), 'pont coupole').tier);
  assert.ok(isHang('pont coupole') && !isHigh('pont coupole'));
});
t('largeurs de colonnes : limites, nettoyage et CSS réservé aux grands écrans', () => {
  assert.equal(clampW(5), MIN_W); assert.equal(clampW(5000), MAX_W); assert.equal(clampW(123.4), 123);
  assert.deepEqual(cleanWidths({ model: 200, bidon: 50, notes: 'x', gels: Infinity, dmx: 10 }), { model: 200, dmx: MIN_W }, 'colonnes inconnues et valeurs abîmées ignorées');
  assert.deepEqual(cleanWidths(null), {});
  assert.equal(colCss({}), '');
  const css = colCss({ model: 300, circuit: 70 });
  assert.match(css, /min-width: 1001px/); assert.match(css, /td\[data-c="model"\][^}]*width: 300px/); assert.match(css, /--cw: 70px/);
});
t('look cahier : tremblé déterministe, extrémités exactes', () => {
  assert.equal(noise(3), noise(3)); assert.ok(Math.abs(noise(7)) <= 1);
  const a = wobblePoints(0, 10, 100, 10, 0.3, 10, 5), b = wobblePoints(0, 10, 100, 10, 0.3, 10, 5);
  assert.deepEqual(a, b, 'même graine = même trait');
  assert.deepEqual(a[0], [0, 10]); assert.deepEqual(a[a.length - 1], [100, 10]);
  assert.ok(a.every(([, y]) => Math.abs(y - 10) <= 0.3 + 1e-9), 'écart maximal respecté');
  assert.equal(wobblePoints(5, 5, 5, 5).length, 2, 'trait nul : deux points');
});
t('saisie de plusieurs références de gel', () => {
  assert.deepEqual(splitGelRefs('L201 + R119'), ['L201', 'R119']);
  assert.deepEqual(splitGelRefs('L200, R114'), ['L200', 'R114']);
  assert.deepEqual(splitGelRefs('L281+#132'), ['L281', '#132'], '# reste dans la référence');
  assert.deepEqual(splitGelRefs(' L201 ; l201 & R80 ,, '), ['L201', 'R80'], 'doublons (casse) et vides retirés');
  assert.deepEqual(splitGelRefs('1/2 CTO'), ['1/2 CTO'], 'la barre oblique n\'est pas un séparateur');
  assert.deepEqual(splitGelRefs('  '), []);
});
t('gélatines demandées : fusion (le plus grand des deux) et porte-filtres', () => {
  const mkGel = (item: number, ref: string) => ({ show_id: 's', item_id: item, ref, color: 'Bleu' });
  const d = { ...EMPTY_DATA,
    filterSizes: [{ id: 'f1', label: '180 x 180' }, { id: 'f2', label: '245 x 245' }],
    models: [{ id: 'a', name: '614 SX', filter_size_id: 'f1' }, { id: 'b', name: 'PAR64', filter_size_id: 'f2' }],
    items: [{ id: 1, model_id: 'a' }, { id: 2, model_id: 'a' }, { id: 3, model_id: 'b' }],
    showDemands: [{ id: 'd1', show_id: 's', model_id: 'a', lamp_id: null, qty: 12, missing: 0 }, { id: 'd2', show_id: 's', model_id: 'b', lamp_id: null, qty: 4, missing: 0 }],
    // posés : 614 SX n°1 et n°2 ont L201 ; n°1 a aussi R119 ; PAR64 n°3 a R80
    showGels: [mkGel(1, 'L201'), mkGel(2, 'L201'), mkGel(1, 'R119'), mkGel(3, 'R80')],
    // demandés : 12 × L201 et 4 × R119 sur les 614 SX ; 9 × R80 sur 4 PAR (plafonné à 4)
    showDemandGels: [{ id: 'g1', show_id: 's', demand_id: 'd1', ref: 'L201', color: 'Bleu', qty: 12 }, { id: 'g2', show_id: 's', demand_id: 'd1', ref: 'R119', color: 'Bleu', qty: 4 },
      { id: 'g3', show_id: 's', demand_id: 'd2', ref: 'R80', color: 'Bleu', qty: 9 }] } as unknown as Data;
  const q = (ref: string) => gelGroups(d, 's').find((g) => g.ref === ref)?.qty;
  assert.equal(q('L201'), 12, 'demandé 12, posé 2 : 12 (pas 14)');
  assert.equal(q('R119'), 4, 'demandé 4, posé 1 : 4');
  assert.equal(q('R80'), 4, 'demandé plafonné à la demande (4), posé 1 : 4');
  const posed = gelGroups(d, 's').find((g) => g.ref === 'L201')!; assert.deepEqual(posed.items, [1, 2], 'les n° posés restent listés');
  // posé plus grand que demandé : le posé l'emporte
  const d2 = { ...d, showGels: [...Array.from({ length: 5 }, (_, i) => mkGel(10 + i, 'R119')), ...d.showGels], items: [...d.items, ...Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, model_id: 'a' }))] } as unknown as Data;
  assert.equal(gelGroups(d2, 's').find((g) => g.ref === 'R119')?.qty, 6, '6 posés (5 + n°1) > 4 demandés');
  // porte-filtres : un par projecteur gélatiné, nommé par modèle
  const h = holderRows(d, 's');
  assert.deepEqual(h.map((x) => [x.model, x.size, x.qty]), [['614 SX', '180 x 180', 12], ['PAR64', '245 x 245', 4]], '614 SX : max(2 projecteurs, 12 demandés) = 12 ; PAR64 : max(1, 4) = 4');
  const only = holderRows({ ...d, showDemandGels: [] } as unknown as Data, 's');
  assert.deepEqual(only.map((x) => [x.model, x.qty]), [['614 SX', 2], ['PAR64', 1]], 'n°1 avec 2 gels = un seul porte-filtre : 2 projecteurs, pas 3 gels');
  // ligne de patch sans projecteur, avec gels : un porte-filtre
  const line = { show_id: 's', item_id: null, model_id: 'b', model_text: '', gels: [{ ref: 'R80', color: 'Bleu' }, { ref: 'R10', color: 'Bleu' }] };
  assert.equal(holderRows({ ...d, showDemandGels: [], showGels: [], patchLines: [line] } as unknown as Data, 's')[0].qty, 1, 'une ligne à 2 gels = 1 porte-filtre');
  assert.deepEqual(holderRows({ ...EMPTY_DATA } as Data, 's'), []);
});
console.log(`\n${n} tests OK`);
