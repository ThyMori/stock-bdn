import assert from 'node:assert/strict';
import { EMPTY_DATA } from '../src/types';
import type { Data, Fault } from '../src/types';
import { isKeeping, keepShowFor, keepText, sentToSav } from '../src/keepFault';

const show = (id: string, start: string, end: string) => ({ id, name: id, start_date: start, end_date: end }) as unknown as Data['shows'][number];
const data = {
  ...EMPTY_DATA,
  shows: [show('passé', '2026-11-01', '2026-11-05'), show('en cours', '2026-11-20', '2026-11-29'), show('suivant', '2026-12-05', '2026-12-09')],
  showItems: [{ show_id: 'passé', item_id: 7 }, { show_id: 'suivant', item_id: 7 }, { show_id: 'en cours', item_id: 4 }, { show_id: 'suivant', item_id: 4 }] as unknown as Data['showItems']
} as Data;
const fault = (o: Partial<Fault>): Fault => ({ id: 'f', item_id: 4, description: 'molette cassée', reported_at: '2026-11-24T10:00:00Z', resolved_at: null, resolution: null, ...o }) as Fault;

// spectacle proposé : celui en cours, sinon le prochain à venir, sinon aucun (le spectacle passé ne compte pas)
assert.equal(keepShowFor(data, 4, '2026-11-24')?.id, 'en cours');
assert.equal(keepShowFor(data, 7, '2026-11-24')?.id, 'suivant');
assert.equal(keepShowFor(data, 99, '2026-11-24'), null);
assert.equal(keepShowFor(data, 7, '2026-12-20'), null);
// « en service » : jusqu'à la date incluse, pas après, pas si résolue ou normale
const k = fault({ keep_until: '2026-11-29' });
assert.equal(isKeeping(k, '2026-11-29'), true);
assert.equal(isKeeping(k, '2026-11-30'), false);
assert.equal(isKeeping(fault({}), '2026-11-24'), false);
assert.equal(isKeeping({ ...k, resolved_at: '2026-11-25T00:00:00Z' }, '2026-11-24'), false);
assert.match(keepText(k, '2026-11-24', (d) => d.slice(8) + '/' + d.slice(5, 7)), /29\/11.*SAV/);
assert.equal(keepText(k, '2026-12-01', (d) => d), '');
// à envoyer en SAV : pannes non bloquantes ouvertes des projecteurs du spectacle
const d2 = { ...data, faults: [k, fault({ id: 'g', item_id: 7, keep_until: '2026-12-09' }), fault({ id: 'h', item_id: 4 })] } as Data;
assert.deepEqual(sentToSav(d2, 'en cours'), [{ item: 4, text: 'molette cassée' }]);
assert.deepEqual(sentToSav(d2, 'passé').map((r) => r.item), [7]);
console.log('keep-fault : OK');
