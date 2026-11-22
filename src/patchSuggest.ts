// Suggestions d'ID pour une ligne de la feuille de patch (mode prépa) : logique pure, sans réseau ni écran, testée dans tests/logic.test.ts.
import type { Data, Show } from './types';
import { blockedReason } from './alerts';
import { describe } from './ref';
import { positionBefore, positionTier, posLabel } from './position';

/** Modèles « similaires » (différents mais interchangeables en pratique), par nom normalisé (majuscules, sans espaces ni tirets).
 *  Pour en ajouter un : une nouvelle liste ici (et dans le README). */
const SIMILAR: string[][] = [
  ['ETC2550', '613SX', '613'], ['614SX', '614S'], ['714SX', '714S', '714'], ['329HPC', '329HPB'], ['310HPC', '306HPC', '306LPC']
];
const key = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Deux modèles (par nom) sont-ils similaires ? Un modèle est évidemment similaire à lui-même. */
export function similarNames(a: string, b: string): boolean {
  const ka = key(a), kb = key(b);
  return ka === kb || SIMILAR.some((g) => g.includes(ka) && g.includes(kb));
}

/** Ce que demande la ligne : modèle, lampe (PAR) et position. Tout est facultatif. */
export interface Want { modelId: string | null; lampId: string | null; par: boolean; position: string }
export type Group = 'same' | 'similar' | 'other';
export interface Suggestion { id: number; group: Group; model: string; reasons: string[] }

/** Projecteurs que l'on peut mettre sur la ligne, du plus judicieux au moins judicieux.
 *  Sont proposés : ceux qui ne sont pas déjà dans le spectacle et sont disponibles SUR TOUTE LA DURÉE de ses dates (ni autre spectacle, ni prêt / SAV, ni panne).
 *  Critères, par ordre d'importance : 1) modèle (le même, puis un modèle similaire, puis les autres) ; 2) disponibilité (filtre ci-dessus) ;
 *  3) position : celle qu'avait le projecteur dans le spectacle juste avant, ou son stock (dessous / 3e s'il a une pastille bleue) — voir `positionTier` ;
 *  4) pour un PAR, lampe déjà montée = lampe voulue ; puis le numéro. */
export function rankStock(data: Data, show: Show, want: Want): Suggestion[] {
  const taken = new Set(data.showItems.filter((s) => s.show_id === show.id).map((s) => s.item_id));
  const wantName = data.models.find((m) => m.id === want.modelId)?.name ?? null;
  const lampName = (id: string | null) => data.lamps.find((l) => l.id === id)?.name;
  const rows = data.items.filter((i) => !taken.has(i.id) && !blockedReason(data, i.id, show)).map((i) => {
    const ds = describe(data, i), name = ds.model?.name ?? '?';
    const group: Group = !want.modelId ? 'other' : i.model_id === want.modelId ? 'same' : wantName && similarNames(wantName, name) ? 'similar' : 'other';
    const par = /^PAR/i.test(ds.type?.name ?? '');
    const lampOk = want.par && par && want.lampId ? (i.lamp_id === want.lampId ? 0 : 1) : 0;
    const pos = positionBefore(data, i.id, show), { tier, exact } = positionTier(pos, want.position);
    const reasons: string[] = [posLabel(pos) + (want.position && tier === 0 ? ' ✓' : '')];
    if (par && i.lamp_id) reasons.push(`${lampName(i.lamp_id)} montée${want.par && want.lampId ? (lampOk === 0 ? ' ✓' : ' (lampe voulue : ' + lampName(want.lampId) + ')') : ''}`);
    return { s: { id: i.id, group, model: name, reasons } as Suggestion, k: [group === 'same' ? 0 : group === 'similar' ? 1 : 2, tier, exact, lampOk, i.id] };
  });
  rows.sort((a, b) => { for (let n = 0; n < a.k.length; n++) if (a.k[n] !== b.k[n]) return a.k[n] - b.k[n]; return 0; });
  return rows.map((r) => r.s);
}
