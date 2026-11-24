/** Panne « non bloquante » : le projecteur reste en service jusqu'à une date, puis un SAV sans date de fin démarre le lendemain. Logique pure (sans réseau ni écran). */
import type { Data, Fault, Show } from './types';

/** Spectacle auquel rattacher la panne : celui en cours qui a ce projecteur, sinon le prochain à venir ; null si aucun (la case « reste en service » n'est alors pas proposée). */
export function keepShowFor(data: Data, itemId: number, today: string): Show | null {
  const mine = data.showItems.filter((r) => r.item_id === itemId).map((r) => data.shows.find((s) => s.id === r.show_id)).filter((s): s is Show => !!s && s.end_date >= today);
  return mine.sort((a, b) => (a.start_date < b.start_date ? -1 : 1))[0] ?? null;
}

/** Panne ouverte, non bloquante, dont la date de fin d'usage n'est pas passée. */
export const isKeeping = (f: Fault, today: string): boolean => !f.resolved_at && !!f.keep_until && today <= f.keep_until;

/** Texte court pour la pastille jaune ; vide si la panne n'est pas (ou plus) dans ce cas. */
export function keepText(f: Fault, today: string, fmt: (iso: string) => string): string {
  return isKeeping(f, today) ? `panne connue · reste en service jusqu'au ${fmt(f.keep_until!)} · SAV ensuite` : '';
}

/** Projecteurs d'un spectacle à envoyer en SAV après lui : pannes ouvertes non bloquantes dont la fin d'usage est la fin du spectacle (ou après le début du SAV prévu). */
export function sentToSav(data: Data, showId: string): { item: number; text: string }[] {
  const ids = new Set(data.showItems.filter((r) => r.show_id === showId).map((r) => r.item_id));
  return data.faults.filter((f) => !f.resolved_at && !!f.keep_until && ids.has(f.item_id))
    .sort((a, b) => a.item_id - b.item_id).map((f) => ({ item: f.item_id, text: f.description ?? 'panne signalée' }));
}
