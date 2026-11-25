// Modification par lot : ce qu'on change, validation, et plan d'application pour chaque projecteur. Logique pure (ni réseau ni écran), donc testable.
import { isParItem } from './scanPositions';
import type { Data } from './types';

/** Ce que l'utilisateur veut changer sur tout le lot (chaque réglage est facultatif ; au moins un). */
export interface BatchChanges {
  blue?: boolean;                                                    // pastille bleue : true = ajouter, false = retirer
  lamp?: string;                                                     // identifiant de la lampe (PAR seulement)
  status?: { kind: 'dispo' | 'sav' | 'en_pret'; note: string; who: string; until: string };   // état : SAV = maintenance sans panne
}
/** Une opération à envoyer pour un projecteur. */
export type BatchStep = { kind: 'blue'; value: boolean } | { kind: 'lamp'; lamp: string } | { kind: 'status'; status: 'dispo' | 'sav' | 'en_pret'; note: string; who: string; until: string };
export interface ItemPlan { steps: BatchStep[]; refused: string[]; unchanged: string[] }

/** Contrôle les réglages choisis avant le scan ; renvoie le message d'erreur, ou null si tout est bon. */
export function validateChanges(c: BatchChanges, today: string): string | null {
  if (c.blue === undefined && !c.lamp && !c.status) return 'Choisis au moins un réglage à modifier.';
  if (c.status?.kind === 'sav' && !c.status.note.trim()) return 'Indique le motif de la maintenance.';
  if (c.status?.kind === 'en_pret' && !c.status.who.trim()) return 'Indique à qui le lot est prêté.';
  if (c.status && c.status.kind !== 'dispo' && c.status.until && c.status.until < today) return 'La date de fin prévue est déjà passée.';
  return null;
}

/** Phrases qui résument les réglages (pour la fenêtre de confirmation). */
export function summarize(data: Data, c: BatchChanges): string[] {
  const out: string[] = [];
  if (c.blue !== undefined) out.push(c.blue ? 'Ajouter la pastille bleue (stocké au 3e)' : 'Retirer la pastille bleue');
  if (c.lamp) out.push(`Lampe : ${data.lamps.find((l) => l.id === c.lamp)?.name ?? '?'} (PAR seulement)`);
  if (c.status) {
    const s = c.status;
    out.push(s.kind === 'dispo' ? 'État : disponible' : s.kind === 'sav' ? `État : SAV, maintenance « ${s.note.trim()} »${s.until ? ` jusqu'au ${s.until.split('-').reverse().join('/')}` : ''}`
      : `État : prêt à ${s.who.trim()}${s.until ? `, retour prévu le ${s.until.split('-').reverse().join('/')}` : ''}`);
  }
  return out;
}

/** Ce qu'il faut faire pour un projecteur : opérations utiles, refus déjà connus (ex. lampe sur un non-PAR) et réglages déjà en place. */
export function planItem(data: Data, itemId: number, c: BatchChanges): ItemPlan {
  const plan: ItemPlan = { steps: [], refused: [], unchanged: [] };
  const it = data.items.find((i) => i.id === itemId);
  if (!it) { plan.refused.push('introuvable'); return plan; }
  if (c.blue !== undefined) { if (!!it.blue_dot === c.blue) plan.unchanged.push('pastille déjà ainsi'); else plan.steps.push({ kind: 'blue', value: c.blue }); }
  if (c.lamp) {
    if (!isParItem(data, itemId)) plan.refused.push('lampe : ce n\'est pas un PAR');
    else if (it.lamp_id === c.lamp) plan.unchanged.push('lampe déjà ainsi');
    else plan.steps.push({ kind: 'lamp', lamp: c.lamp });
  }
  if (c.status) {
    if (it.status === c.status.kind) plan.unchanged.push('état déjà ainsi');
    else plan.steps.push({ kind: 'status', status: c.status.kind, note: c.status.note.trim(), who: c.status.who.trim(), until: c.status.until });
  }
  return plan;
}

/** Combien de projecteurs du lot sont affectés à un spectacle en cours ou à venir (pour avertir avant un SAV ou un prêt). */
export function inUpcomingShows(data: Data, ids: number[], today: string): number {
  const live = new Set(data.shows.filter((s) => s.end_date >= today).map((s) => s.id));
  return ids.filter((n) => data.showItems.some((r) => r.item_id === n && live.has(r.show_id))).length;
}
