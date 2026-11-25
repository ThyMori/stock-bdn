import { POSITIONS } from './patch';
// Zones du théâtre pour le matériel demandé : plateau, face, corbeille. Logique pure (ni réseau ni écran), donc testable.
export type Zone = '' | 'plateau' | 'face' | 'corbeille';   // '' = indifférent
/** Zones proposées dans les formulaires, avec leur libellé. */
export const ZONES: [Zone, string][] = [['', 'Indifférent'], ['plateau', 'Plateau'], ['face', 'Face'], ['corbeille', 'Corbeille']];
/** Libellé d'une zone (vide pour « indifférent »). */
export const zoneLabel = (z: string | null | undefined): string => ZONES.find(([k]) => k === z)?.[1] && z ? ZONES.find(([k]) => k === z)![1] : '';
/** Zone d'une position de la feuille de patch. « autre », vide ou inconnue = '' (indifférent). */
export function zoneOfPosition(position: string | null | undefined): Zone {
  const p = (position ?? '').trim().toLowerCase();
  if (!p) return '';
  if (/^p(\d|10)$/.test(p) || p.startsWith('allemande') || p.startsWith('passerelle') || p.startsWith('mezza') || p === 'sol' || p === 'pont coupole') return 'plateau';
  if (p === '2e balcon' || p === '3e balcon' || p === 'coupole') return 'face';
  if (p === 'corbeille') return 'corbeille';
  return '';
}
/** Positions de la feuille de patch qui appartiennent à une zone, dans l'ordre habituel. */
export const positionsOfZone = (z: Zone): string[] => POSITIONS.filter((p) => zoneOfPosition(p) === z);
