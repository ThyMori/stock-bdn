import type { Data, Item, Lamp } from './types';

/** Résout les identifiants (modèle, type, lampe…) d'un projecteur en libellés. */
export function describe(data: Data, item: Item) {
  const model = data.models.find((m) => m.id === item.model_id);
  const type = data.types.find((t) => t.id === model?.type_id);
  const family = data.families.find((f) => f.id === model?.family_id);
  const lamp = data.lamps.find((l) => l.id === item.lamp_id);
  const socket = data.sockets.find((s) => s.id === (model?.socket_id ?? lamp?.socket_id));
  const filter = data.filterSizes.find((f) => f.id === model?.filter_size_id);
  return { model, type, family, lamp, socket, filter };
}

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Le projecteur est-il un PAR ? */
export const isPar = (data: Data, item: Item): boolean => /^PAR/i.test(describe(data, item).type?.name ?? '');
/** Lampes proposées en changement rapide, dans l'ordre d'usage : CP62, CP61, CP60, CP95. */
export function parLamps(data: Data): Lamp[] {
  const rank = (n: string) => { const i = ['CP62', 'CP61', 'CP60', 'CP95'].findIndex((k) => n.toUpperCase().startsWith(k)); return i < 0 ? 99 : i; };
  return data.lamps.filter((l) => /^CP\d+/i.test(l.name)).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
