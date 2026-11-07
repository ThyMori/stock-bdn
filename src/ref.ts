import type { Data, Item } from './types';

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
