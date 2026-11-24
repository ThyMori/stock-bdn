/** Logique pure de la sélection par lots de la feuille de patch (aucun accès au réseau ni à l'écran : testable). */

/** Une cible envoyée au serveur : un projecteur affecté (item) ou une ligne sans projecteur (line). */
export type BatchTarget = { item: number } | { line: string };

/** Transforme les clés de lignes (« i12 » pour le projecteur 12, « l<uuid> » pour une ligne N/C) en cibles pour le serveur. Les clés inconnues sont ignorées. */
export function batchTargets(keys: Iterable<string>): BatchTarget[] {
  const out: BatchTarget[] = [];
  for (const k of keys) {
    if (/^i\d+$/.test(k)) out.push({ item: Number(k.slice(1)) });
    else if (/^l[0-9a-f-]{36}$/i.test(k)) out.push({ line: k.slice(1) });
  }
  return out;
}

/** Clés comprises entre deux lignes (incluses) dans l'ordre affiché : sert au clic avec Maj. Si l'une des deux n'est pas affichée, seule `to` est renvoyée. */
export function rangeKeys(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from), b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** Actions de modification en lot proposées selon les droits (le serveur les contrôle aussi) : technicien = grada, courbe, gélatines ; assigné = tout. */
export type BatchAction = 'position' | 'curve' | 'acc_add' | 'acc_remove' | 'gel_add' | 'gel_clear' | 'state' | 'notes' | 'clear_circuit' | 'clear_dimmer' | 'clear_dmx';
export function batchActions(actor: boolean): [BatchAction, string][] {
  const tech: [BatchAction, string][] = [['curve', 'Courbe…'], ['gel_add', 'Ajouter des gélatines…'], ['gel_clear', 'Vider les gélatines'], ['clear_dimmer', 'Vider la grada']];
  if (!actor) return tech;
  return [['position', 'Position…'], ['curve', 'Courbe…'], ['acc_add', 'Ajouter un accessoire…'], ['acc_remove', 'Retirer un accessoire…'], ['gel_add', 'Ajouter des gélatines…'], ['gel_clear', 'Vider les gélatines'],
    ['state', 'État…'], ['notes', 'Note…'], ['clear_circuit', 'Vider le circuit'], ['clear_dimmer', 'Vider la grada'], ['clear_dmx', 'Vider le DMX']];
}

/** Libellé d'un nombre de lignes : « 1 ligne », « 4 lignes ». */
export const lignes = (n: number): string => `${n} ligne${n > 1 ? 's' : ''}`;
