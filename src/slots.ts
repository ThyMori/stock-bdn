// Répartition d'une demande par zone et par position : logique pure (ni réseau ni écran), donc testable.
import type { Data, ShowDemandSlot } from './types';
import type { Zone } from './zones';

/** Une ligne de répartition : `position` nulle = nombre de la zone entière. */
export interface Slot { zone: Exclude<Zone, ''>; position: string | null; qty: number }
export const ZONE_ORDER: Slot['zone'][] = ['plateau', 'face', 'corbeille'];

/** Répartition enregistrée d'une demande. */
export const slotsOf = (data: Data, demandId: string): Slot[] =>
  (data.showDemandSlots ?? []).filter((s: ShowDemandSlot) => s.demand_id === demandId).map((s) => ({ zone: s.zone, position: s.position, qty: s.qty }));

/** Nombre de projecteurs par zone (lignes sans position). */
export const zoneCount = (slots: Slot[], z: Slot['zone']): number => slots.filter((s) => s.zone === z && s.position === null).reduce((n, s) => n + s.qty, 0);
/** Total réparti dans les zones. */
export const slotsTotal = (slots: Slot[]): number => ZONE_ORDER.reduce((n, z) => n + zoneCount(slots, z), 0);

/** Message d'erreur si la répartition est impossible pour une demande de `qty` projecteurs, sinon null. */
export function validateSlots(slots: Slot[], qty: number): string | null {
  for (const z of ZONE_ORDER) {
    const pos = slots.filter((s) => s.zone === z && s.position !== null).reduce((n, s) => n + s.qty, 0);
    if (pos > zoneCount(slots, z)) return `Zone ${z} : les positions (${pos}) dépassent le nombre de la zone (${zoneCount(slots, z)}).`;
  }
  const tot = slotsTotal(slots);
  return tot > qty ? `La répartition (${tot}) dépasse la quantité demandée (${qty}).` : null;
}

/** Résumé court d'une répartition : « Plateau 8 (P5 : 4, P6 : 2) · Face 4 ». Vide si rien n'est réparti. */
export function slotsText(slots: Slot[], labels: Record<string, string>): string {
  return ZONE_ORDER.filter((z) => zoneCount(slots, z) > 0).map((z) => {
    const det = slots.filter((s) => s.zone === z && s.position !== null).map((s) => `${s.position} : ${s.qty}`);
    return `${labels[z] ?? z} ${zoneCount(slots, z)}${det.length ? ` (${det.join(', ')})` : ''}`;
  }).join(' · ');
}
