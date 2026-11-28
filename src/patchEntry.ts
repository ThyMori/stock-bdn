// Saisie rapide du patch par scan (grada, DIRECT, adresse DMX) : logique pure (ni réseau ni écran), donc testable.
import type { Data } from './types';

/** Valeurs saisies pour un projecteur : circuit, voie de gradateur (grada), DIRECT ou non, univers et adresse DMX. */
export interface Entry { circuit: string; dimmer: string; direct: boolean; universe: string; address: string }

/** Ce qui est enregistré sur la feuille de patch pour ce projecteur (vide si pas de ligne). Le DMX s'écrit « univers-adresse », ex. 1-45. */
export function entryOf(data: Data, showId: string, item: number): Entry {
  const l = data.patchLines.find((x) => x.show_id === showId && x.item_id === item);
  const [u, a] = (l?.dmx ?? '').split('-');
  return { circuit: l?.circuit ?? '', dimmer: l?.dimmer ?? '', direct: !!l?.curve?.includes('direct'), universe: u ?? '', address: a ?? '' };
}

/** Une touche du pavé appliquée à un champ : chiffre ajouté, « back » efface le dernier, « clear » vide. */
export function keypad(current: string, key: string, max = 6): string {
  if (key === 'clear') return '';
  if (key === 'back') return current.slice(0, -1);
  return /^\d$/.test(key) && current.length < max ? current + key : current;
}

/** Adresse DMX « univers-adresse » (ex. 1-45), vide si rien de saisi ; message d'erreur si incomplète ou hors limites (univers 1 à 999, adresse 1 à 512). */
export function dmxValue(universe: string, address: string): { value: string } | { error: string } {
  if (!universe && !address) return { value: '' };
  if (!universe || !address) return { error: 'DMX : il faut l\'univers ET l\'adresse.' };
  if (!/^\d{1,3}$/.test(universe) || Number(universe) < 1) return { error: 'DMX : l\'univers va de 1 à 999.' };
  if (!/^\d{1,3}$/.test(address) || Number(address) < 1 || Number(address) > 512) return { error: 'DMX : l\'adresse va de 1 à 512.' };
  return { value: `${Number(universe)}-${Number(address)}` };
}

/** Envois à faire au serveur pour passer de `before` à `after`, dans l'ordre : courbe d'abord (le DMX n'existe qu'avec DIRECT), puis DMX, puis grada, puis circuit. */
export function entryOps(before: Entry, after: Entry): { field: 'curve' | 'dmx' | 'dimmer' | 'circuit'; value: string | string[] }[] | { error: string } {
  const ops: { field: 'curve' | 'dmx' | 'dimmer' | 'circuit'; value: string | string[] }[] = [];
  if (after.direct !== before.direct) ops.push({ field: 'curve', value: [after.direct ? 'direct' : 'lineaire'] });   // retirer DIRECT : le serveur vide le DMX
  if (after.direct) {
    const d = dmxValue(after.universe, after.address);
    if ('error' in d) return d;
    const was = before.universe && before.address ? `${Number(before.universe)}-${Number(before.address)}` : '';
    if (d.value !== was) ops.push({ field: 'dmx', value: d.value });
  }
  if (after.dimmer.trim() !== before.dimmer.trim()) ops.push({ field: 'dimmer', value: after.dimmer.trim() });
  if (after.circuit.trim() !== before.circuit.trim()) ops.push({ field: 'circuit', value: after.circuit.trim() });
  return ops;
}
