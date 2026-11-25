import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data, Item, Op } from '../src/types';
import { applyPending, immoLastDay, prevDay, todayStr } from '../src/logic';
import { blockedReason } from '../src/alerts';

assert.equal(prevDay('2026-12-01'), '2026-11-30'); assert.equal(prevDay('2026-03-01'), '2026-02-28');
assert.equal(immoLastDay({ closed_date: '2026-11-25', end_date: null }), '2026-11-24');     // clos le 25 : libre le 25
assert.equal(immoLastDay({ closed_date: null, end_date: '2026-11-25' }), '2026-11-25');     // fin prévue incluse
assert.equal(immoLastDay({ closed_date: null, end_date: null }), '9999-12-31');             // sans fin connue

const T = todayStr(), plus = (n: number) => { const d = new Date(T + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const show = (a: number, b: number) => ({ id: 's', name: 'S', start_date: plus(a), end_date: plus(b) }) as unknown as Data['shows'][number];
const imm = (o: object) => ({ id: 'i', item_id: 1, kind: 'sav', who: null, note: null, start_date: plus(-3), end_date: null, closed_date: null, ...o }) as unknown as Data['immos'][number];
const d = (immos: Data['immos']) => ({ ...EMPTY_DATA, immos }) as Data;
assert.equal(blockedReason(d([imm({})]), 1, show(-1, 5)), 'SAV');                                   // SAV ouvert : bloque
assert.equal(blockedReason(d([imm({ closed_date: plus(0) })]), 1, show(-1, 5)), null);              // clos aujourd'hui : libre (spectacle commencé hier)
assert.equal(blockedReason(d([imm({ start_date: plus(-10), closed_date: plus(-8) })]), 1, show(-4, 6)), null);   // SAV passé : jours passés ignorés
assert.equal(blockedReason(d([imm({ start_date: plus(2), end_date: plus(3) })]), 1, show(1, 4)), 'SAV');          // SAV planifié : bloque
assert.equal(blockedReason(d([imm({ kind: 'pret', end_date: plus(2) })]), 1, show(0, 3)), 'prêt');                // prêt rendu dans 2 jours : bloque
assert.equal(blockedReason(d([imm({})]), 1, show(-9, -5)), null);                                    // spectacle entièrement passé : rien à bloquer

// panne résolue hors ligne : la dernière referme le SAV (affichage immédiat)
const item = { id: 1, status: 'sav', status_at: plus(-1) + 'T10:00:00Z' } as unknown as Item;
const fault = (id: string, o = {}) => ({ id, item_id: 1, description: 'x', reported_at: plus(-1) + 'T10:00:00Z', resolved_at: null, resolution: null, ...o });
const base = { ...EMPTY_DATA, items: [item], immos: [imm({ start_date: plus(-1) })], faults: [fault('a'), fault('b')] } as unknown as Data;
const res = (id: string): Op => ({ id: 'o' + id, kind: 'resolve', fault: id, at: T + 'T12:00:00Z' }) as Op;
const one = applyPending(base, [res('a')]);
assert.equal(one.items[0].status, 'sav');                                                           // il reste une panne ouverte
const both = applyPending(base, [res('a'), res('b')]);
assert.equal(both.items[0].status, 'dispo'); assert.equal(both.immos[0].closed_date, T);
console.log('immo-days OK');
