import type { Data, Show } from './types';

export interface ShowAlert { show: Show; missing: { label: string; n: number }[]; problems: { item: number; why: string }[] }

/** Spectacles à venir ou en cours pour lesquels on n'arrive pas à fournir le matériel (demande non satisfaite ou projecteur indisponible). */
export function showAlerts(data: Data, today: string): ShowAlert[] {
  const out: ShowAlert[] = [];
  for (const show of [...data.shows].filter((s) => s.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    const missing = data.showDemands.filter((x) => x.show_id === show.id && x.missing > 0).map((x) => {
      const m = data.models.find((mm) => mm.id === x.model_id);
      const l = data.lamps.find((ll) => ll.id === x.lamp_id);
      return { label: `${m?.name ?? '?'}${l ? ' ' + l.name : ''}`, n: x.missing };
    });
    const problems = data.showItems.filter((s) => s.show_id === show.id && s.problem).map((s) => ({ item: s.item_id, why: s.problem as string }));
    if (missing.length || problems.length) out.push({ show, missing, problems });
  }
  return out;
}
export const alertText = (a: ShowAlert): string =>
  [...a.missing.map((m) => `il manque ${m.n} × ${m.label}`), ...(a.problems.length ? [`${a.problems.length} projecteur${a.problems.length > 1 ? 's' : ''} indisponible${a.problems.length > 1 ? 's' : ''}`] : [])].join(' · ');

/** Raison pour laquelle un projecteur ne peut pas servir à ce spectacle (autre spectacle aux mêmes dates, prêt / SAV, panne ouverte), sinon null. */
export function blockedReason(data: Data, itemId: number, show: Show): string | null {
  const other = data.showItems.find((r) => r.item_id === itemId && r.show_id !== show.id && data.shows.some((s) => s.id === r.show_id && s.start_date <= show.end_date && s.end_date >= show.start_date));
  if (other) return `déjà dans « ${data.shows.find((s) => s.id === other.show_id)?.name ?? '?'} »`;
  const imm = data.immos.find((m) => m.item_id === itemId && m.start_date <= show.end_date && (m.closed_date ?? m.end_date ?? '9999-12-31') >= show.start_date);
  if (imm) return imm.kind === 'pret' ? 'prêt' : 'SAV';
  if (data.faults.some((f) => f.item_id === itemId && !f.resolved_at)) return 'en panne';
  return null;
}
