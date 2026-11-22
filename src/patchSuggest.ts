// Suggestions d'ID pour une ligne de la feuille de patch (mode prépa) : logique pure, sans réseau ni écran, testée dans tests/logic.test.ts.
import type { Data, Show } from './types';
import { blockedReason } from './alerts';
import { describe } from './ref';

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

/** Dernière position connue de chaque projecteur d'après la chronologie des spectacles : celle du spectacle le plus récent
 *  (date de début) qui a une position saisie pour lui. `before` : on ne regarde que les spectacles commencés à cette date ou avant ;
 *  `exceptShow` : spectacle à ignorer (celui qu'on est en train de préparer). */
export function lastPositions(data: Data, exceptShow: string | null, before: string): Map<number, { position: string; show: string; at: string }> {
  const out = new Map<number, { position: string; show: string; at: string }>();
  for (const l of data.patchLines) {
    if (l.show_id === exceptShow || l.item_id === null || !l.position) continue;
    const sh = data.shows.find((s) => s.id === l.show_id); if (!sh || sh.start_date > before) continue;
    const cur = out.get(l.item_id), at = sh.start_date + ' ' + sh.end_date;   // ordre chronologique : début puis fin du spectacle
    if (!cur || at > cur.at) out.set(l.item_id, { position: l.position, show: sh.name, at });
  }
  return out;
}
/** Dernière position utilisée d'un projecteur (fiche projecteur) : spectacles commencés jusqu'à aujourd'hui. */
export function lastPositionOf(data: Data, itemId: number, today: string): { position: string; show: string } | null {
  return lastPositions(data, null, today).get(itemId) ?? null;
}

/** Projecteurs que l'on peut mettre sur la ligne, du plus judicieux au moins judicieux.
 *  Sont proposés : ceux qui ne sont pas déjà dans le spectacle et sont disponibles à ses dates (ni autre spectacle, ni prêt / SAV, ni panne).
 *  Classement : 1) même modèle, puis modèle similaire, puis les autres ; 2) disponibilité réelle (« disponible » avant « utilisé ») ;
 *  3) pour un PAR, lampe déjà montée = lampe voulue ; 4) dernière position connue = position de la ligne ; 5) numéro. */
export function rankStock(data: Data, show: Show, want: Want): Suggestion[] {
  const taken = new Set(data.showItems.filter((s) => s.show_id === show.id).map((s) => s.item_id));
  const last = lastPositions(data, show.id, show.start_date);   // ce que le projecteur faisait avant ce spectacle
  const wantName = data.models.find((m) => m.id === want.modelId)?.name ?? null;
  const lampName = (id: string | null) => data.lamps.find((l) => l.id === id)?.name;
  const rows = data.items.filter((i) => !taken.has(i.id) && !blockedReason(data, i.id, show)).map((i) => {
    const ds = describe(data, i), name = ds.model?.name ?? '?';
    const group: Group = !want.modelId ? 'other' : i.model_id === want.modelId ? 'same' : wantName && similarNames(wantName, name) ? 'similar' : 'other';
    const avail = (i.eff ?? i.status) === 'dispo' ? 0 : 1;
    const par = /^PAR/i.test(ds.type?.name ?? '');
    const lampOk = want.par && par && want.lampId ? (i.lamp_id === want.lampId ? 0 : 1) : 0;
    const lp = last.get(i.id);
    const posOk = want.position && lp ? (lp.position === want.position ? 0 : 1) : 1;
    const reasons: string[] = [avail === 0 ? 'disponible' : 'utilisé ailleurs, libre à ces dates'];
    if (par && i.lamp_id) reasons.push(`${lampName(i.lamp_id)} montée${want.par && want.lampId ? (lampOk === 0 ? ' ✓' : ' (lampe voulue : ' + lampName(want.lampId) + ')') : ''}`);
    if (lp) reasons.push(`était ${lp.position === want.position ? '✓ ' : ''}au ${lp.position} (${lp.show})`);
    return { s: { id: i.id, group, model: name, reasons } as Suggestion, k: [group === 'same' ? 0 : group === 'similar' ? 1 : 2, avail, lampOk, posOk, i.id] };
  });
  rows.sort((a, b) => { for (let n = 0; n < a.k.length; n++) if (a.k[n] !== b.k[n]) return a.k[n] - b.k[n]; return 0; });
  return rows.map((r) => r.s);
}
