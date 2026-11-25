// Pré-affectation « depuis le spectacle précédent » : logique pure (aucun accès réseau ni DOM), donc testable.
import { blockedReason } from './alerts';
import type { Data, Show } from './types';

/** Un projecteur proposé pour une demande du spectacle. */
export interface Proposal {
  item: number;              // numéro du projecteur
  demandId: string;          // demande du spectacle qu'il comble
  modelId: string;           // modèle du projecteur
  lamp: string | null;       // lampe à monter (PAR seulement), sinon null
  relamp: boolean;           // vrai si le PAR n'a pas encore la bonne lampe (il faudra le relamper)
  from: 'prev' | 'stock';    // d'où il vient : déjà monté sur le spectacle précédent, ou en stock
}
/** Ce qui manque encore sur une demande après la proposition. */
export interface Shortage { demandId: string; modelId: string; lamp: string | null; n: number }
export interface Plan { proposals: Proposal[]; shortages: Shortage[]; alreadyOk: number }

/** Spectacles qui précèdent `target` (début plus tôt), dans l'ordre chronologique. */
export function previousShows(data: Data, target: Show): Show[] {
  return data.shows.filter((s) => s.id !== target.id && s.start_date < target.start_date)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.end_date.localeCompare(b.end_date));
}
/** Spectacle proposé par défaut : celui en cours aujourd'hui, sinon celui qui finit le plus près avant `target`. */
export function defaultPrevious(list: Show[], today: string): Show | null {
  const running = list.filter((s) => s.start_date <= today && s.end_date >= today);
  if (running.length) return running[running.length - 1];
  return [...list].sort((a, b) => b.end_date.localeCompare(a.end_date))[0] ?? null;
}

/** Calcule les projecteurs à pré-affecter à `target` depuis `prev`, selon les quantités de « Matériel demandé ». */
export function preAssignPlan(data: Data, target: Show, prev: Show): Plan {
  const inPrev = new Set(data.showItems.filter((r) => r.show_id === prev.id).map((r) => r.item_id));
  const inTarget = new Set(data.showItems.filter((r) => r.show_id === target.id).map((r) => r.item_id));
  const taken = new Set<number>();                                       // projecteurs déjà proposés dans ce calcul
  const item = (id: number) => data.items.find((i) => i.id === id);
  // un projecteur est utilisable s'il n'est pas déjà dans le spectacle, pas bloqué, et sans panne non bloquante ouverte
  const usable = (id: number): boolean => !inTarget.has(id) && !taken.has(id) && !blockedReason(data, id, target)
    && !data.faults.some((f) => f.item_id === id && !f.resolved_at);
  // reste à fournir par demande = quantité − prêts/locations − substitutions − manque déclaré − déjà affectés utilisables
  const left = new Map<string, number>();
  let alreadyOk = 0;
  const demands = data.showDemands.filter((d) => d.show_id === target.id);
  for (const d of demands) {
    const ext = data.showExternals.filter((e) => e.demand_id === d.id).reduce((n, e) => n + e.qty, 0);
    const sub = data.showSubstitutions.filter((e) => e.demand_id === d.id).reduce((n, e) => n + e.qty, 0);
    const own = data.showItems.filter((r) => r.show_id === target.id && !r.problem && item(r.item_id)?.model_id === d.model_id && (!d.lamp_id || r.lamp_id === d.lamp_id)).length;
    alreadyOk += own;
    left.set(d.id, Math.max(0, d.qty - ext - sub - (d.missing ?? 0) - own));
  }
  const proposals: Proposal[] = [];
  const byModel = (modelId: string, pool: 'prev' | 'stock') => data.items.filter((i) => i.model_id === modelId && (pool === 'prev') === inPrev.has(i.id) && usable(i.id)).sort((a, b) => a.id - b.id);
  // une passe = un lot de candidats pour toutes les demandes concernées, dans l'ordre des demandes
  const pass = (pick: (d: (typeof demands)[number]) => { items: ReturnType<typeof byModel>; relamp: boolean; from: 'prev' | 'stock' }) => {
    for (const d of demands) {
      const need = left.get(d.id) ?? 0;
      if (need <= 0) continue;
      const { items, relamp, from } = pick(d);
      for (const it of items) {
        if ((left.get(d.id) ?? 0) <= 0) break;
        if (!usable(it.id)) continue;
        taken.add(it.id);
        left.set(d.id, (left.get(d.id) ?? 0) - 1);
        proposals.push({ item: it.id, demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, relamp, from });
      }
    }
  };
  const good = (d: (typeof demands)[number], pool: 'prev' | 'stock') => byModel(d.model_id, pool).filter((i) => !d.lamp_id || i.lamp_id === d.lamp_id);
  const wrong = (d: (typeof demands)[number], pool: 'prev' | 'stock') => byModel(d.model_id, pool).filter((i) => d.lamp_id && i.lamp_id !== d.lamp_id);
  pass((d) => ({ items: good(d, 'prev'), relamp: false, from: 'prev' }));      // 1. déjà montés sur le spectacle précédent, bonne lampe (ou projecteur sans lampe)
  pass((d) => ({ items: wrong(d, 'prev'), relamp: true, from: 'prev' }));      // 2. en dernier : PAR du spectacle précédent à relamper
  // on ne pioche JAMAIS en stock : les projecteurs absents du spectacle précédent sont affectés à la prépa (liste de prépa + scan)
  const shortages: Shortage[] = demands.filter((d) => (left.get(d.id) ?? 0) > 0).map((d) => ({ demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, n: left.get(d.id)! }));
  return { proposals, shortages, alreadyOk };
}
