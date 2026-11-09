import { addDays, dayNum, esc, todayStr } from '../logic';
import { showColor } from '../types';
import type { Show } from '../types';

/** Rappel bleu : matériel prêté / loué (de la livraison à la reprise). */
export interface CalExt { show_id: string; start: string; end: string; label: string }

export type CalMode = 'month' | 'week';

/** Lundi de la semaine contenant d (AAAA-MM-JJ). */
export const mondayOf = (d: string): string => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
const monthStart = (d: string): string => d.slice(0, 8) + '01';
const addMonths = (d: string, n: number): string => { const x = new Date(monthStart(d) + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

/** Date de référence décalée d'une période (mois ou semaine). */
export const shiftRef = (ref: string, mode: CalMode, dir: number): string => (mode === 'month' ? addMonths(ref, dir) : addDays(ref, 7 * dir));

const DOW = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const title = (ref: string, mode: CalMode): string => {
  if (mode === 'month') return new Date(ref + 'T00:00:00Z').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const a = mondayOf(ref), b = addDays(a, 6), f = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f(a)} – ${f(b)}`;
};

/** Une semaine : cases des jours + barres des spectacles (placées sur des lignes libres). */
function weekHtml(first: string, shows: Show[], mine: (id: string) => boolean, today: string, curMonth: string | null, tall: boolean, exts: CalExt[]): string {
  const last = addDays(first, 6);
  const inWeek = shows.filter((s) => s.start_date <= last && s.end_date >= first).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name));
  const lanes: number[] = [];                                  // dernier jour (numéro) occupé par ligne
  const extIn = exts.filter((x) => x.start <= last && x.end >= first).sort((a, b) => a.start.localeCompare(b.start));
  const place = (start: string, end: string) => {
    const c0 = Math.max(dayNum(start), dayNum(first)) - dayNum(first), c1 = Math.min(dayNum(end), dayNum(last)) - dayNum(first);
    let l = lanes.findIndex((e) => e < c0); if (l < 0) { l = lanes.length; lanes.push(-1); } lanes[l] = c1;
    return { c0, c1, l, cut: (start < first ? ' cut-l' : '') + (end > last ? ' cut-r' : '') };
  };
  const bars = inWeek.map((s) => {
    const c0 = Math.max(dayNum(s.start_date), dayNum(first)) - dayNum(first), c1 = Math.min(dayNum(s.end_date), dayNum(last)) - dayNum(first);
    let l = lanes.findIndex((end) => end < c0); if (l < 0) { l = lanes.length; lanes.push(-1); } lanes[l] = c1;
    const cut = (s.start_date < first ? ' cut-l' : '') + (s.end_date > last ? ' cut-r' : '');
    return `<a class="cbar ${mine(s.id) ? 'mine' : 'grey'}${cut}" style="--c:${showColor(s)};grid-column:${c0 + 1} / ${c1 + 2};grid-row:${l + 2}" href="#/show/${s.id}" title="${esc(s.name)}${mine(s.id) ? '' : ' (non assigné)'}">${esc(s.name)}</a>`;
  }).join('') + extIn.map((x) => {
    const { c0, c1, l, cut } = place(x.start, x.end);
    return `<a class="cbar ext${cut}" style="grid-column:${c0 + 1} / ${c1 + 2};grid-row:${l + 2}" href="#/show/${x.show_id}" title="${esc(x.label)}">${esc(x.label)}</a>`;
  }).join('');
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(first, i), n = Number(d.slice(8));
    const off = curMonth && d.slice(0, 7) !== curMonth ? ' off' : '';
    return `<div class="cday${off}${d === today ? ' today' : ''}" style="grid-column:${i + 1};grid-row:1 / span ${Math.max(lanes.length, tall ? 3 : 1) + 1}">${n}</div>`;
  }).join('');
  return `<div class="cweek${tall ? ' tall' : ''}">${days}${bars}</div>`;
}

export function calendarHtml(shows: Show[], ref: string, mode: CalMode, mine: (id: string) => boolean, exts: CalExt[] = []): string {
  const today = todayStr();
  const nav = `<div class="row"><button class="btn" data-act="cal-prev" aria-label="Période précédente">‹</button>
    <div class="grow ctitle">${esc(title(ref, mode))}</div>
    <button class="btn" data-act="cal-today">Auj.</button><button class="btn" data-act="cal-next" aria-label="Période suivante">›</button></div>`;
  const head = `<div class="chead">${DOW.map((d) => `<span>${d}</span>`).join('')}</div>`;
  let body = '';
  if (mode === 'month') {
    const first = mondayOf(monthStart(ref)); const cur = ref.slice(0, 7);
    const weeks = Math.ceil((dayNum(addDays(monthStart(addMonths(ref, 1)), -1)) - dayNum(first) + 1) / 7);
    for (let w = 0; w < weeks; w++) body += weekHtml(addDays(first, w * 7), shows, mine, today, cur, false, exts);
  } else body = weekHtml(mondayOf(ref), shows, mine, today, null, true, exts);
  return `<div class="cal">${nav}${head}${body}<div class="sub clegend"><i class="cbar mine"></i> assigné <i class="cbar grey"></i> non assigné <i class="cbar ext"></i> prêté / loué</div></div>`;
}
