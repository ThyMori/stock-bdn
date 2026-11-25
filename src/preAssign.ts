// Pré-affectation « depuis le spectacle précédent » : logique pure (aucun accès réseau ni DOM), donc testable.
import { blockedReason } from './alerts';
import { patchPosition } from './position';
import { slotsOf, zoneCount } from './slots';
import type { Data, Show } from './types';
import { zoneOfPosition } from './zones';
import type { Zone } from './zones';

/** Un projecteur proposé pour une demande du spectacle. */
export interface Proposal {
  item: number;              // numéro du projecteur
  demandId: string;          // demande du spectacle qu'il comble
  modelId: string;           // modèle du projecteur
  lamp: string | null;       // lampe à monter (PAR seulement), sinon null
  relamp: boolean;           // vrai si le PAR n'a pas encore la bonne lampe (il faudra le relamper)
  from: 'prev' | 'stock';    // d'où il vient : déjà monté sur le spectacle précédent, ou en stock
  zone: Zone;                // zone pour laquelle on l'affecte ('' = sans zone précise)
  how: 'same' | 'cross' | 'any' | 'repeche';   // même zone (il reste en place) · autre zone (déplacé) · sans zone précise · repêché faute de stock
  fromPosition: string;      // position qu'il avait sur le spectacle précédent ('' si inconnue)
}
/** À préparer depuis un stock pour une zone : projecteurs absents du spectacle précédent (feuille de prépa + scan). */
export interface PrepNeed { demandId: string; modelId: string; lamp: string | null; zone: Zone; n: number; from: 'dessous' | 'stock3'; fallback: boolean }
/** Ce qui manque encore sur une demande après la proposition. */
export interface Shortage { demandId: string; modelId: string; lamp: string | null; n: number }
export interface Plan { proposals: Proposal[]; shortages: Shortage[]; alreadyOk: number; prepNeeds: PrepNeed[]; unavailable: Shortage[] }

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

/** Besoin d'une zone sur une demande : combien de projecteurs, dont certains à une position précise. */
interface Need { demandId: string; zone: Zone; n: number; pos: Map<string, number> }
const ZONES_NEED: Exclude<Zone, ''>[] = ['plateau', 'face', 'corbeille'];

/** Calcule les projecteurs à pré-affecter à `target` depuis `prev`, selon « Matériel demandé » et sa répartition par zone / position.
 *  Règles : on ne prend que des projecteurs du spectacle précédent (jamais le stock). Même zone = on garde ; autre zone : pour le plateau et la
 *  corbeille on garde ceux SANS pastille bleue, pour la face ceux AVEC pastille bleue (les autres seront rangés au démontage : dessous / 3e).
 *  Ce qui manque est à préparer depuis les dessous (plateau, corbeille, sans zone) ou le 3e (face), avec repli sur l'autre stock. */
export function preAssignPlan(data: Data, target: Show, prev: Show): Plan {
  const inPrev = new Set(data.showItems.filter((r) => r.show_id === prev.id).map((r) => r.item_id));
  const inTarget = new Set(data.showItems.filter((r) => r.show_id === target.id).map((r) => r.item_id));
  const taken = new Set<number>();                                       // projecteurs déjà proposés dans ce calcul
  const item = (id: number) => data.items.find((i) => i.id === id);
  // un projecteur est utilisable s'il n'est pas déjà dans le spectacle, pas bloqué, et sans panne non bloquante ouverte
  const usable = (id: number): boolean => !inTarget.has(id) && !taken.has(id) && !blockedReason(data, id, target)
    && !data.faults.some((f) => f.item_id === id && !f.resolved_at);
  const demands = data.showDemands.filter((d) => d.show_id === target.id);
  const dById = new Map(demands.map((d) => [d.id, d]));
  let alreadyOk = 0;
  const needs: Need[] = [];
  for (const d of demands) {
    const ext = data.showExternals.filter((e) => e.demand_id === d.id).reduce((n, e) => n + e.qty, 0);
    const sub = data.showSubstitutions.filter((e) => e.demand_id === d.id).reduce((n, e) => n + e.qty, 0);
    const total = Math.max(0, d.qty - ext - sub - (d.missing ?? 0));       // à fournir par le stock du théâtre
    const own = data.showItems.filter((r) => r.show_id === target.id && !r.problem && item(r.item_id)?.model_id === d.model_id && (!d.lamp_id || r.lamp_id === d.lamp_id));
    alreadyOk += own.length;
    // besoin par zone d'après la répartition ; le reste = « sans zone précise »
    const slots = slotsOf(data, d.id);
    const byZone = new Map<Zone, Need>();
    for (const z of ZONES_NEED) {
      const pos = new Map<string, number>();
      for (const sl of slots.filter((x) => x.zone === z && x.position !== null)) pos.set(sl.position!, (pos.get(sl.position!) ?? 0) + sl.qty);
      byZone.set(z, { demandId: d.id, zone: z, n: zoneCount(slots, z), pos });
    }
    const zoned = ZONES_NEED.reduce((n, z) => n + byZone.get(z)!.n, 0);
    byZone.set('', { demandId: d.id, zone: '', n: Math.max(0, total - zoned), pos: new Map() });
    // les projecteurs déjà affectés (avec leur zone) réduisent d'abord leur zone, sinon le « sans zone », sinon la première zone restante
    for (const r of own) {
      const z = (r.zone ?? '') as Zone;
      const bp = patchPosition(data, target.id, r.item_id);
      const tryDec = (k: Zone): boolean => { const nd = byZone.get(k)!; if (nd.n <= 0) return false; nd.n--; const q = nd.pos.get(bp) ?? 0; if (q > 0) nd.pos.set(bp, q - 1); return true; };
      if (!(z && tryDec(z)) && !tryDec('')) [...ZONES_NEED].some((k) => tryDec(k));
    }
    // si le total dépasse ce qui reste à fournir (prêts, manque…), on rogne d'abord le « sans zone », puis corbeille, face, plateau
    let excess = [...byZone.values()].reduce((n, x) => n + x.n, 0) - Math.max(0, total - own.length);
    for (const k of ['', 'corbeille', 'face', 'plateau'] as Zone[]) { const nd = byZone.get(k)!; const cut = Math.min(nd.n, Math.max(0, excess)); nd.n -= cut; excess -= cut; }
    for (const k of [...ZONES_NEED, '' as Zone]) { const nd = byZone.get(k)!; if (nd.n > 0) needs.push(nd); }
  }

  const proposals: Proposal[] = [];
  const posOf = (id: number) => patchPosition(data, prev.id, id);
  const take = (nd: Need, it: ReturnType<typeof item> & object, relamp: boolean, how: Proposal['how']) => {
    const d = dById.get(nd.demandId)!;
    taken.add(it.id); nd.n--;
    const fp = posOf(it.id), q = nd.pos.get(fp) ?? 0; if (q > 0) nd.pos.set(fp, q - 1);   // une position précise est comblée
    proposals.push({ item: it.id, demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, relamp, from: 'prev', zone: nd.zone, how, fromPosition: fp });
  };
  /** Le projecteur `it` (du précédent) convient-il à ce besoin ? Renvoie la priorité (0 = idéal) ou null s'il est écarté. */
  const rank = (nd: Need, it: { id: number; blue_dot?: boolean | null }): { pr: number; how: Proposal['how'] } | null => {
    if (nd.zone === '') return { pr: 2, how: 'any' };                                  // sans zone précise : tout convient
    const fp = posOf(it.id), zA = zoneOfPosition(fp);
    if (zA === nd.zone) return { pr: (nd.pos.get(fp) ?? 0) > 0 ? -1 : 0, how: 'same' };   // même zone (position exacte en premier) : on garde
    // autre zone (ou position inconnue = « autre zone ») : face → seulement pastille bleue ; plateau / corbeille → seulement sans pastille
    return (nd.zone === 'face') === !!it.blue_dot ? { pr: 1, how: 'cross' } : null;
  };
  // 1. bonne lampe, 2. en dernier : PAR à relamper ; dans chaque passe, les zones précises d'abord, puis « sans zone »
  const phase = (relamp: boolean) => {
    const ordered = [...needs.filter((x) => x.zone !== ''), ...needs.filter((x) => x.zone === '')];
    for (const nd of ordered) {
      if (nd.n <= 0) continue;
      const d = dById.get(nd.demandId)!;
      const cands = data.items.filter((i) => i.model_id === d.model_id && inPrev.has(i.id) && usable(i.id)
        && (!d.lamp_id || (i.lamp_id === d.lamp_id) !== relamp)).flatMap((i) => { const r = rank(nd, i); return r ? [{ i, r }] : []; })
        .sort((a, b) => a.r.pr - b.r.pr || a.i.id - b.i.id);
      for (const c of cands) { if (nd.n <= 0) break; if (usable(c.i.id)) take(nd, c.i, relamp, c.r.how); }
    }
  };
  phase(false); phase(true);

  // 3. ce qui reste : à préparer depuis le stock (face → 3e, sinon dessous) ; si ce stock est vide, on repêche un projecteur du précédent
  //    écarté (il serait rangé au démontage), sinon repli sur l'autre stock ; sinon il manque vraiment.
  const stock = new Map<string, { dessous: number; stock3: number }>();
  const stockOfModel = (m: string) => {
    if (!stock.has(m)) {
      const free = data.items.filter((i) => i.model_id === m && !inPrev.has(i.id) && usable(i.id));
      stock.set(m, { dessous: free.filter((i) => !i.blue_dot).length, stock3: free.filter((i) => !!i.blue_dot).length });
    }
    return stock.get(m)!;
  };
  const prepNeeds: PrepNeed[] = [], unavailable: Shortage[] = [];
  const addPrep = (nd: Need, d: (typeof demands)[number], from: PrepNeed['from'], fallback: boolean) => {
    const f = prepNeeds.find((x) => x.demandId === d.id && x.zone === nd.zone && x.from === from && x.fallback === fallback);
    if (f) f.n++; else prepNeeds.push({ demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, zone: nd.zone, n: 1, from, fallback });
  };
  for (const nd of [...needs.filter((x) => x.zone !== ''), ...needs.filter((x) => x.zone === '')]) {
    const d = dById.get(nd.demandId)!;
    const st = stockOfModel(d.model_id);
    const nominal: 'dessous' | 'stock3' = nd.zone === 'face' ? 'stock3' : 'dessous', other = nominal === 'dessous' ? 'stock3' : 'dessous';
    while (nd.n > 0) {
      if (st[nominal] > 0) { st[nominal]--; nd.n--; addPrep(nd, d, nominal, false); continue; }
      const ign = data.items.filter((i) => i.model_id === d.model_id && inPrev.has(i.id) && usable(i.id))
        .sort((a, b) => Number(!!d.lamp_id && a.lamp_id !== d.lamp_id) - Number(!!d.lamp_id && b.lamp_id !== d.lamp_id) || a.id - b.id)[0];
      if (ign) { take(nd, ign, !!d.lamp_id && ign.lamp_id !== d.lamp_id, 'repeche'); continue; }
      if (st[other] > 0) { st[other]--; nd.n--; addPrep(nd, d, other, true); continue; }
      const u = unavailable.find((x) => x.demandId === d.id); if (u) u.n++; else unavailable.push({ demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, n: 1 });
      nd.n--;
    }
  }
  // « à fournir » restant par demande = ce qui n'est pas proposé (à préparer + introuvable)
  const left = new Map<string, number>();
  for (const x of prepNeeds) left.set(x.demandId, (left.get(x.demandId) ?? 0) + x.n);
  for (const x of unavailable) left.set(x.demandId, (left.get(x.demandId) ?? 0) + x.n);
  const shortages: Shortage[] = demands.filter((d) => (left.get(d.id) ?? 0) > 0).map((d) => ({ demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, n: left.get(d.id)! }));
  return { proposals, shortages, alreadyOk, prepNeeds, unavailable };
}
