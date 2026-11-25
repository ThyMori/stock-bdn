// « Affecter des positions » par scan : logique pure (ni réseau ni écran), donc testable.
import { describe } from './ref';
import type { Data } from './types';

/** Résultat d'un scan : accepté (avec « déjà dans le spectacle » ou non) ou refusé avec un message. */
export type ScanVerdict = { ok: true; inShow: boolean } | { ok: false; msg: string };

/** Vrai si le projecteur est un PAR (la lampe compte alors pour l'affectation). */
export const isParItem = (data: Data, itemId: number): boolean => {
  const it = data.items.find((i) => i.id === itemId);
  return !!it && /^PAR/i.test(describe(data, it).type?.name ?? '');
};

/** Juge un numéro scanné par rapport au lot en cours et au spectacle. */
export function classifyScan(data: Data, showId: string, n: number | null, lot: number[]): ScanVerdict {
  if (n === null) return { ok: false, msg: 'QR non reconnu.' };
  if (!data.items.some((i) => i.id === n)) return { ok: false, msg: `Projecteur n° ${n} introuvable.` };
  if (lot.includes(n)) return { ok: false, msg: `N° ${n} déjà dans le lot.` };
  return { ok: true, inShow: data.showItems.some((s) => s.show_id === showId && s.item_id === n) };
}

/** Sépare le lot : projecteurs déjà dans le spectacle, et ceux à affecter d'abord (groupés par lampe de leur fiche ; un PAR sans lampe est refusé). */
export function splitLot(data: Data, showId: string, lot: number[]): { inShow: number[]; out: Map<string, number[]>; noLamp: number[] } {
  const inShow: number[] = [], out = new Map<string, number[]>(), noLamp: number[] = [];
  for (const n of lot) {
    if (data.showItems.some((s) => s.show_id === showId && s.item_id === n)) { inShow.push(n); continue; }
    const lamp = isParItem(data, n) ? data.items.find((i) => i.id === n)?.lamp_id ?? '' : '';
    if (isParItem(data, n) && !lamp) { noLamp.push(n); continue; }
    out.set(lamp, [...(out.get(lamp) ?? []), n]);
  }
  return { inShow, out, noLamp };
}
