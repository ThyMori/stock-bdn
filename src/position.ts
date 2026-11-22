// Position d'un projecteur dans le théâtre : logique pure (sans réseau ni écran), testée dans tests/logic.test.ts.
import type { Data, Show } from './types';
import { currentImmo } from './logic';

/** Positions « en hauteur » préférées pour les projecteurs stockés au 3e (pastille bleue). */
export const HIGH_POSITIONS = ['3e', 'balcon', 'coupole'];
/** Positions « cintres / en place » : Px, mezzas, allemandes, passerelles, sols. La corbeille compte dans les deux familles. */
export const isHang = (p: string): boolean => /^P\d+$/.test(p) || /^(mezza|allemande|passerelle) [JC]$/.test(p) || p === 'sol' || p === 'corbeille';
export const isHigh = (p: string): boolean => HIGH_POSITIONS.includes(p) || p === 'corbeille';

/** Où est un projecteur : dans un spectacle (à la position de sa feuille de patch), au stock des dessous ou du 3e, en prêt ou en SAV. */
export interface Pos { kind: 'show' | 'dessous' | 'stock3' | 'pret' | 'sav'; position: string; show: string }

/** Jour (AAAA-MM-JJ) d'un horodatage, à l'heure locale. */
const dayOf = (iso: string): string => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Un spectacle est-il monté ce jour-là ?
 *  - pendant l'exploitation : toujours monté (figé) ;
 *  - avant : selon l'interrupteur ;
 *  - après le dernier jour : démonté automatiquement, sauf si l'interrupteur a été mis sur « monté » après cette date. */
export function showMounted(show: Show, today: string): boolean {
  if (today >= show.start_date && today <= show.end_date) return true;
  if (today < show.start_date) return !!show.mounted;
  return !!show.mounted && !!show.mounted_at && dayOf(show.mounted_at) > show.end_date;
}

/** Position d'un projecteur sur la feuille de patch d'un spectacle (« » si elle n'est pas renseignée). */
export function patchPosition(data: Data, showId: string, itemId: number): string {
  return data.patchLines.find((l) => l.show_id === showId && l.item_id === itemId)?.position ?? '';
}

/** Stock où va un projecteur qui ne joue pas : les dessous, ou le 3e s'il a une pastille bleue. */
const stockOf = (data: Data, itemId: number): Pos => ({ kind: data.items.find((i) => i.id === itemId)?.blue_dot ? 'stock3' : 'dessous', position: '', show: '' });

/** Position actuelle (aujourd'hui) : prêt / SAV, sinon spectacle monté (position de sa feuille), sinon stock. */
export function positionNow(data: Data, itemId: number, today: string): Pos {
  const im = currentImmo(data.immos, itemId, today);
  if (im) return { kind: im.kind === 'pret' ? 'pret' : 'sav', position: '', show: '' };
  const mounted = data.showItems.filter((r) => r.item_id === itemId).map((r) => data.shows.find((s) => s.id === r.show_id))
    .filter((s): s is Show => !!s && showMounted(s, today)).sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
  if (mounted) return { kind: 'show', position: patchPosition(data, mounted.id, itemId), show: mounted.name };
  return stockOf(data, itemId);
}

/** Spectacle chronologiquement juste avant celui-ci (dernière date de début antérieure), s'il y en a un. */
export function previousShow(data: Data, show: Show): Show | null {
  return data.shows.filter((s) => s.id !== show.id && (s.start_date < show.start_date || (s.start_date === show.start_date && s.id < show.id)))
    .sort((a, b) => (a.start_date === b.start_date ? (a.id < b.id ? 1 : -1) : a.start_date < b.start_date ? 1 : -1))[0] ?? null;
}

/** Position d'un projecteur au moment où on prépare ce spectacle : celle qu'il avait dans le spectacle juste avant (feuille de patch), sinon le stock. */
export function positionBefore(data: Data, itemId: number, show: Show): Pos {
  const prev = previousShow(data, show);
  if (prev && data.showItems.some((r) => r.show_id === prev.id && r.item_id === itemId)) return { kind: 'show', position: patchPosition(data, prev.id, itemId), show: prev.name };
  return stockOf(data, itemId);
}

/** Texte court d'une position : « au 3e (Hamlet) », « stock 3e », « stock dessous », « PRÊT », « SAV ». */
export function posLabel(p: Pos): string {
  if (p.kind === 'pret') return 'PRÊT'; if (p.kind === 'sav') return 'SAV';
  if (p.kind === 'stock3') return 'stock 3e'; if (p.kind === 'dessous') return 'stock dessous';
  return `${p.position || 'position non renseignée'}${p.show ? ' (' + p.show + ')' : ''}`;
}

/** Ordre de préférence d'une position de projecteur pour une ligne à monter à la position voulue (0 = le mieux).
 *  - ligne en hauteur (3e, balcon, coupole) : stock 3e ou déjà à cette position, puis une autre position haute, puis les dessous, puis le reste ;
 *  - corbeille (haute ET cintres) : déjà là, puis stock 3e, puis les dessous ;
 *  - Px, mezza, allemande, passerelle, sol : déjà là, puis les dessous, puis le stock 3e ;
 *  - sans position voulue (ou « autre ») : aucun critère. */
export function positionTier(pos: Pos, want: string): { tier: number; exact: number } {
  const exact = pos.kind === 'show' && pos.position === want ? 0 : 1;
  if (!want || want === 'autre') return { tier: 0, exact: 1 };
  if (HIGH_POSITIONS.includes(want)) {
    if (exact === 0 || pos.kind === 'stock3') return { tier: 0, exact };
    if (pos.kind === 'show' && HIGH_POSITIONS.includes(pos.position)) return { tier: 1, exact };
    return { tier: pos.kind === 'dessous' ? 2 : 3, exact };
  }
  if (want === 'corbeille') return { tier: exact === 0 ? 0 : pos.kind === 'stock3' ? 1 : pos.kind === 'dessous' ? 2 : 3, exact };
  return { tier: exact === 0 ? 0 : pos.kind === 'dessous' ? 1 : pos.kind === 'stock3' ? 2 : 3, exact };
}
