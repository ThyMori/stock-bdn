import { addDays, dayNum, esc, todayStr } from '../logic';
import { showColor } from '../types';
import type { Show } from '../types';

/** Rappel bleu : matériel prêté / loué (de la livraison à la reprise). */
export interface CalExt { show_id: string; start: string; end: string; label: string }

/** « rolling » = calendrier glissant : 1 semaine passée, la semaine en cours et 3 semaines à venir. */
export type CalMode = 'rolling' | 'week';
export const ROLLING_BEFORE = 1, ROLLING_WEEKS = 4;

// Semaines dont les prêts / locations sont dépliés (clé = lundi de la semaine). Replié par défaut : une seule ligne résume les prêts de la semaine.
const openExt = new Set<string>();
export const toggleCalExt = (week: string): void => { if (openExt.has(week)) openExt.delete(week); else openExt.add(week); };

/** Lundi de la semaine contenant d (AAAA-MM-JJ). */
export const mondayOf = (d: string): string => addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
/** Premier lundi affiché par le calendrier glissant autour de la date de référence. */
export const rollingStart = (ref: string): string => addDays(mondayOf(ref), -7 * ROLLING_BEFORE);

/** Date de référence décalée d'une semaine (les deux modes avancent semaine par semaine). */
export const shiftRef = (ref: string, dir: number): string => addDays(ref, 7 * dir);

const DOW = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const title = (ref: string, mode: CalMode): string => {
  const f = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const a = mode === 'rolling' ? rollingStart(ref) : mondayOf(ref), b = addDays(a, (mode === 'rolling' ? 7 * ROLLING_WEEKS : 7) - 1);
  return `${f(a)} – ${f(b)}`;
};

/** Une semaine : cases des jours + barres des spectacles (placées sur des lignes libres). */
function weekHtml(first: string, shows: Show[], mine: (id: string) => boolean, today: string, tall: boolean, exts: CalExt[]): string {
  const last = addDays(first, 6);
  const inWeek = shows.filter((s) => s.start_date <= last && s.end_date >= first).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name));
  const lanes: number[] = [];                                  // dernier jour (numéro) occupé par ligne
  const extIn = exts.filter((x) => x.start <= last && x.end >= first).sort((a, b) => a.start.localeCompare(b.start));
  const place = (start: string, end: string) => {
    const c0 = Math.max(dayNum(start), dayNum(first)) - dayNum(first), c1 = Math.min(dayNum(end), dayNum(last)) - dayNum(first);
    let l = lanes.findIndex((e) => e < c0); if (l < 0) { l = lanes.length; lanes.push(-1); } lanes[l] = c1;
    return { c0, c1, l, cut: (start < first ? ' cut-l' : '') + (end > last ? ' cut-r' : '') };
  };
  const grouped = extIn.length > 1, expanded = openExt.has(first);   // une seule ligne dès 2 prêts / locations dans la semaine
  const bars = inWeek.map((s) => {
    const c0 = Math.max(dayNum(s.start_date), dayNum(first)) - dayNum(first), c1 = Math.min(dayNum(s.end_date), dayNum(last)) - dayNum(first);
    let l = lanes.findIndex((end) => end < c0); if (l < 0) { l = lanes.length; lanes.push(-1); } lanes[l] = c1;
    const cut = (s.start_date < first ? ' cut-l' : '') + (s.end_date > last ? ' cut-r' : '');
    const state = s.end_date < today ? ' past' : s.start_date <= today ? ' now' : '';   // terminé : terni · en cours : mis en emphase
    return `<a class="cbar ${mine(s.id) ? 'mine' : 'grey'}${cut}${state}" style="--c:${showColor(s)};grid-column:${c0 + 1} / ${c1 + 2};grid-row:${l + 2}" href="#/show/${s.id}" title="${esc(s.name)}${mine(s.id) ? '' : ' (non assigné)'}">${esc(s.name)}</a>`;
  }).join('') + (() => {
    if (!grouped) return '';
    const sp = place(extIn.reduce((a, x) => (x.start < a ? x.start : a), extIn[0].start), extIn.reduce((a, x) => (x.end > a ? x.end : a), extIn[0].end));   // de la première livraison à la dernière reprise
    return `<button type="button" class="cbar ext cgroup${sp.cut}" style="grid-column:${sp.c0 + 1} / ${sp.c1 + 2};grid-row:${sp.l + 2}" data-act="cal-ext" data-v="${first}" aria-expanded="${expanded}" title="${extIn.length} prêts / locations : appuyer pour ${expanded ? 'replier' : 'déplier'}">${expanded ? '▾' : '▸'} ${extIn.length} prêts / locations</button>`;
  })() + extIn.map((x) => {
    if (grouped && !expanded) return '';   // replié : seule la ligne de résumé est visible
    const { c0, c1, l, cut } = place(x.start, x.end);
    return `<a class="cbar ext${cut}" style="grid-column:${c0 + 1} / ${c1 + 2};grid-row:${l + 2}" href="#/show/${x.show_id}" title="${esc(x.label)}">${esc(x.label)}</a>`;
  }).join('');
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(first, i), n = Number(d.slice(8));
    const num = n === 1 ? `1 ${new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { month: 'short', timeZone: 'UTC' })}` : String(n);   // le 1er du mois affiche le mois
    return `<div class="cday${d < today ? ' pastday' : ''}${d === today ? ' today' : ''}" style="grid-column:${i + 1};grid-row:1 / span ${Math.max(lanes.length, tall ? 3 : 1) + 1}"><span class="dn">${num}</span></div>`;
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
  if (mode === 'rolling') {
    const first = rollingStart(ref);
    for (let w = 0; w < ROLLING_WEEKS; w++) body += weekHtml(addDays(first, w * 7), shows, mine, today, false, exts);
  } else body = weekHtml(mondayOf(ref), shows, mine, today, true, exts);
  return `<div class="cal">${nav}${head}${body}<div class="sub clegend"><i class="cbar mine"></i> assigné <i class="cbar grey"></i> non assigné <i class="cbar ext"></i> prêté / loué</div></div>`;
}
