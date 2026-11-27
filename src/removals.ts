// Projecteurs retirés d'un spectacle à venir parce qu'ils sont tombés en panne / en SAV (ou prêtés) : bandeau à afficher. Logique pure.
import type { Data } from './types';

export interface RemovalBanner { id: string; text: string; strong: boolean; kept: boolean }

/** Bandeaux d'un spectacle. Un projecteur RETIRÉ reste signalé tant que le trou n'est pas comblé (moins d'affectés utilisables que demandés
 *  pour son modèle) ; un projecteur GARDÉ (déjà patché) reste signalé tant qu'il est indisponible dans le spectacle. Rien une fois le spectacle commencé.
 *  `strong` = le spectacle était entièrement affecté juste avant : bandeau plus fort. */
export function removalBanners(data: Data, showId: string, today: string): RemovalBanner[] {
  const show = data.shows.find((s) => s.id === showId);
  if (!show || show.start_date <= today) return [];                                       // spectacle commencé : on ne touche plus à rien
  const out: RemovalBanner[] = [];
  for (const r of data.showRemovals.filter((x) => x.show_id === showId).sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const model = data.models.find((m) => m.id === r.model_id)?.name ?? 'projecteur';
    const row = data.showItems.find((x) => x.show_id === showId && x.item_id === r.item_id);
    if (r.kept) {
      if (!row || !row.problem) continue;                                                 // plus dans le spectacle, ou redevenu disponible
      out.push({ id: r.id, kept: true, strong: r.was_complete, text: `N° ${r.item_id} (${model}) : ${r.reason}. Il est déjà patché, donc il reste dans le spectacle : à toi de décider.` });
      continue;
    }
    if (row) continue;                                                                    // réaffecté à la main : plus d'alerte
    const need = data.showDemands.filter((d) => d.show_id === showId && d.model_id === r.model_id).reduce((n, d) => n
      + Math.max(0, d.qty - data.showExternals.filter((e) => e.demand_id === d.id).reduce((k, e) => k + e.qty, 0)
                       - data.showSubstitutions.filter((b) => b.demand_id === d.id).reduce((k, b) => k + b.qty, 0)), 0);
    const have = data.showItems.filter((x) => x.show_id === showId && !x.problem && data.items.find((i) => i.id === x.item_id)?.model_id === r.model_id).length;
    const hole = need - have;
    if (hole <= 0) continue;                                                              // le trou est comblé
    out.push({ id: r.id, kept: false, strong: r.was_complete, text: `N° ${r.item_id} (${model}) retiré du spectacle : ${r.reason}. Il manque ${hole} × ${model} à affecter${r.zone ? ` (il était prévu pour ${r.zone === 'face' ? 'la face' : r.zone === 'corbeille' ? 'la corbeille' : 'le plateau'})` : ''}.` });
  }
  return out;
}
