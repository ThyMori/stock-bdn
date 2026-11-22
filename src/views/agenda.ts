import { addDays, barSpan, dayNum, esc, immoState, todayStr } from '../logic';
import type { Immo } from '../types';

export const fmtDay = (d: string | null): string => (d ? d.split('-').reverse().join('/') : '—');
const KIND = { pret: 'Prêt', sav: 'SAV', show: 'Spectacle' } as const;

export const WINDOW_DAYS = 20;   // 5 jours avant aujourd'hui, aujourd'hui, 14 jours à venir
const BEFORE = 5;                 // jours affichés avant aujourd'hui
export const AGENDA_STEP = 14;    // pas des flèches ‹ › (en jours)

/** Fenêtre glissante de 20 jours (5 jours précédents, le jour en cours, 14 jours à venir), décalée de `offset` jours. Une graduation tous les 5 jours. */
export function dayWindow(today: string, offset: number): { from: string; to: string; ticks: { label: string; at: string }[] } {
  const from = addDays(today, -BEFORE + offset), to = addDays(from, WINDOW_DAYS - 1);
  const ticks = Array.from({ length: WINDOW_DAYS / 5 }, (_, k) => { const at = addDays(from, k * 5); return { at, label: at.slice(8, 10) + '/' + at.slice(5, 7) }; });
  return { from, to, ticks };
}

/** Frise des immobilisations (vert = disponible, jaune = prêt, rouge = SAV) puis liste détaillée. */
export function agendaHtml(immos: Immo[], offset: number, canEdit: boolean): string {
  const today = todayStr();
  const w = dayWindow(today, offset);
  const total = dayNum(w.to) - dayNum(w.from) + 1;
  const sorted = [...immos].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  // plusieurs périodes qui se chevauchent : chacune sur sa ligne
  const lanes: number[] = [];
  const bars = sorted.map((i) => {
    const sp = barSpan(i, w.from, w.to); if (!sp) return '';
    const s = dayNum(i.start_date), e = i.closed_date || i.end_date ? dayNum((i.closed_date ?? i.end_date)!) : dayNum(w.to);
    let lane = lanes.findIndex((end) => end < s); if (lane < 0) { lane = lanes.length; lanes.push(e); } else lanes[lane] = e;
    const st = immoState(i, today);
    return `<div class="bar ${i.kind} ${st} ${sp.openEnd ? 'open' : ''}" style="left:${sp.left.toFixed(2)}%;width:${sp.width.toFixed(2)}%;top:${lane * 16}px"
      title="${KIND[i.kind]}${i.who ? ' · ' + esc(i.who) : ''} · ${fmtDay(i.start_date)} → ${i.closed_date ? fmtDay(i.closed_date) : i.end_date ? fmtDay(i.end_date) + ' (prévu)' : 'en cours'}"></div>`;
  }).join('');
  const todayPos = ((dayNum(today) - dayNum(w.from)) / total) * 100;
  const ticks = w.ticks.map((m) => `<span style="left:${(((dayNum(m.at) - dayNum(w.from)) / total) * 100).toFixed(2)}%">${esc(m.label)}</span>`).join('');
  const rows = [...immos].sort((a, b) => (a.start_date < b.start_date ? 1 : -1)).map((i) => {
    const st = immoState(i, today);
    const late = st === 'late' ? Math.round(dayNum(today) - dayNum(i.end_date!)) : 0;
    const when = i.kind === 'show' ? `du ${fmtDay(i.start_date)} au ${fmtDay(i.end_date)}` : i.closed_date ? `du ${fmtDay(i.start_date)} au ${fmtDay(i.closed_date)}`
      : i.end_date ? `du ${fmtDay(i.start_date)} au ${fmtDay(i.end_date)} <span class="muted">(${i.kind === 'pret' ? 'retour' : 'fin'} prévu${i.kind === 'pret' ? '' : 'e'})</span>`
      : `depuis le ${fmtDay(i.start_date)} <span class="muted">(fin non connue)</span>`;
    const tag = st === 'late' ? `<span class="tag late">en retard de ${late} j</span>` : st === 'planned' ? '<span class="tag">à venir</span>' : st === 'running' ? '<span class="tag run">en cours</span>' : '';
    return `<div class="immo-row"><i class="sw ${i.kind}"></i><div class="grow"><div><b>${KIND[i.kind]}</b>${i.who ? ' · ' + (i.kind === 'show' ? `<a href="#/show/${i.show_id}">${esc(i.who)}</a>` : esc(i.who)) : ''} ${tag}${i.pending ? ' <span class="pending">en attente</span>' : ''}</div>
        <div class="sub">${when}${i.note ? ' · ' + esc(i.note) : ''}</div></div>
      ${canEdit && !i.pending && i.kind !== 'show' ? `<div class="stack" style="gap:6px"><button class="btn small" data-act="immo-edit" data-v="${i.id}">Modifier</button><button class="btn small danger" data-act="immo-del" data-v="${i.id}">Supprimer</button></div>` : ''}</div>`;
  }).join('');
  return `<div class="row"><h2 class="grow">Agenda</h2>
      <button class="chip" data-act="agenda-nav" data-v="-${AGENDA_STEP}" aria-label="${AGENDA_STEP} jours plus tôt">‹</button>
      <button class="chip" data-act="agenda-nav" data-v="0" aria-label="Aujourd'hui">Auj.</button>
      <button class="chip" data-act="agenda-nav" data-v="${AGENDA_STEP}" aria-label="${AGENDA_STEP} jours plus tard">›</button></div>
    <div class="frise"><div class="ticks">${ticks}</div>
      <div class="track" style="height:${Math.max(1, lanes.length) * 16 + 4}px"><div class="free"></div>${bars}
        ${todayPos >= 0 && todayPos <= 100 ? `<div class="today" style="left:${todayPos.toFixed(2)}%"></div>` : ''}</div></div>
    <div class="legend-mini"><span><i class="sw dispo"></i>libre</span><span><i class="sw pret"></i>prêt</span><span><i class="sw sav"></i>SAV</span><span><i class="sw show"></i>spectacle</span></div>
    ${rows || '<div class="sub">Aucune immobilisation enregistrée : ce projecteur n\'a jamais été prêté ni passé en SAV depuis la création de l\'agenda.</div>'}
    ${canEdit ? '<button class="btn small" data-act="immo-add">+ Planifier / ajouter une période</button>' : ''}`;
}
