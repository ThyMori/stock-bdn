// Préparation : ce qu'il reste à sortir du stock par zone, et où ranger un projecteur scanné. Logique pure (ni réseau ni écran), donc testable.
import { blockedReason } from './alerts';
import { computeNeeds } from './preAssign';
import type { Need, PrepNeed, Shortage } from './preAssign';
import { positionBefore } from './position';
import type { Data, Show } from './types';
import type { Zone } from './zones';

/** Stock d'où l'on prépare normalement pour une zone : face = 3e (pastille bleue), le reste = dessous. */
export const nominalStock = (z: Zone): 'dessous' | 'stock3' => (z === 'face' ? 'stock3' : 'dessous');

/** Un projecteur est-il disponible pour ce spectacle (hors spectacle, sans blocage, sans panne ouverte) ? */
const free = (data: Data, show: Show, id: number): boolean =>
  !data.showItems.some((r) => r.show_id === show.id && r.item_id === id) && !blockedReason(data, id, show) && !data.faults.some((f) => f.item_id === id && !f.resolved_at);

/** Reste à préparer par demande et par zone, avec le stock d'où le sortir (repli sur l'autre stock signalé), et ce qui est introuvable.
 *  Seuls les projecteurs EN STOCK comptent (ceux qui sont encore montés sur le spectacle précédent n'en font pas partie). */
export function remainingNeeds(data: Data, show: Show): { prep: PrepNeed[]; unavailable: Shortage[] } {
  const { needs, demands } = computeNeeds(data, show);
  const stock = new Map<string, { dessous: number; stock3: number }>();
  const stockOf = (m: string) => {
    if (!stock.has(m)) {
      const list = data.items.filter((i) => i.model_id === m && free(data, show, i.id) && positionBefore(data, i.id, show).kind !== 'show');
      stock.set(m, { dessous: list.filter((i) => !i.blue_dot).length, stock3: list.filter((i) => !!i.blue_dot).length });
    }
    return stock.get(m)!;
  };
  const prep: PrepNeed[] = [], unavailable: Shortage[] = [];
  const add = (nd: Need, from: PrepNeed['from'], fallback: boolean) => {
    const d = demands.find((x) => x.id === nd.demandId)!;
    const f = prep.find((x) => x.demandId === d.id && x.zone === nd.zone && x.from === from && x.fallback === fallback);
    if (f) f.n++; else prep.push({ demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, zone: nd.zone, n: 1, from, fallback });
  };
  for (const nd of [...needs.filter((x) => x.zone !== ''), ...needs.filter((x) => x.zone === '')]) {
    const d = demands.find((x) => x.id === nd.demandId)!, st = stockOf(d.model_id);
    const nominal = nominalStock(nd.zone), other = nominal === 'dessous' ? 'stock3' : 'dessous';
    for (let k = nd.n; k > 0; k--) {
      if (st[nominal] > 0) { st[nominal]--; add(nd, nominal, false); }
      else if (st[other] > 0) { st[other]--; add(nd, other, true); }
      else { const u = unavailable.find((x) => x.demandId === d.id); if (u) u.n++; else unavailable.push({ demandId: d.id, modelId: d.model_id, lamp: d.lamp_id, n: 1 }); }
    }
  }
  return { prep, unavailable };
}

/** Où ranger un projecteur scanné pendant la prépa. `ask` = question à poser avant d'affecter (zone différente de son stock d'origine). */
export type PrepTarget = { ok: true; demandId: string; lamp: string | null; relamp: boolean; zone: Zone; ask: string } | { ok: false; msg: string };

/** Juge un projecteur scanné : sur quelle ligne de demande encore incomplète l'affecter, et dans quelle zone.
 *  La zone suit son stock d'origine (pastille bleue = 3e = face ; sinon dessous = plateau / corbeille). Sans zone précise : accepté sans question.
 *  S'il ne reste de besoin que dans une autre zone, on pose la question (`ask`). */
export function prepScanTarget(data: Data, show: Show, itemId: number): PrepTarget {
  const it = data.items.find((i) => i.id === itemId);
  if (!it) return { ok: false, msg: `Projecteur n° ${itemId} introuvable.` };
  if (data.showItems.some((r) => r.show_id === show.id && r.item_id === itemId)) return { ok: false, msg: `N° ${itemId} est déjà affecté à ce spectacle.` };
  const why = blockedReason(data, itemId, show);
  if (why) return { ok: false, msg: `N° ${itemId} indisponible : ${why}` };
  if (data.faults.some((f) => f.item_id === itemId && !f.resolved_at)) return { ok: false, msg: `N° ${itemId} est en panne.` };
  const { needs, demands } = computeNeeds(data, show);
  const mine = needs.filter((n) => demands.find((d) => d.id === n.demandId)?.model_id === it.model_id && n.n > 0);
  if (!mine.length) return { ok: false, msg: `Plus de besoin pour ce modèle : la demande est complète (augmente la quantité si besoin).` };
  const home: 'face' | 'plateau' = it.blue_dot ? 'face' : 'plateau';            // zone naturelle de son stock d'origine
  const fits = (n: Need) => (n.zone === '' ? 1 : n.zone === home || (home === 'plateau' && n.zone === 'corbeille') ? 0 : 2);   // 0 = sa zone, 1 = sans zone précise, 2 = autre zone (on demande)
  const lampOk = (n: Need) => { const d = demands.find((x) => x.id === n.demandId)!; return !d.lamp_id || d.lamp_id === it.lamp_id ? 0 : 1; };
  const pick = [...mine].sort((a, b) => lampOk(a) - lampOk(b) || fits(a) - fits(b))[0];   // bonne lampe d'abord, puis la zone qui lui va
  const dd = demands.find((x) => x.id === pick.demandId)!;
  const zoneName = (z: Zone) => (z === 'face' ? 'la face' : z === 'corbeille' ? 'la corbeille' : 'le plateau');
  const ask = fits(pick) === 2 ? `Le n° ${itemId} vient du ${it.blue_dot ? 'stock du 3e (pastille bleue)' : 'stock des dessous'}, mais il ne reste de besoin que pour ${zoneName(pick.zone)}. L'affecter quand même ?` : '';
  return { ok: true, demandId: dd.id, lamp: dd.lamp_id, relamp: !!dd.lamp_id && dd.lamp_id !== it.lamp_id, zone: pick.zone, ask };
}
