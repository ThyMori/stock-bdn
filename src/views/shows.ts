import type { ViewFactory } from '../router';
import { go } from '../router';
import { can, canActShow, rpcCall, view } from '../store';
import { calendarHtml, shiftRef } from './calendar';
import type { CalMode } from './calendar';
import { esc, todayStr, uuid } from '../logic';
import { openForm } from '../ui/dialog';
import { fmtDay } from './agenda';
import { showColor } from '../types';
import { calendarExternals, showAlerts } from '../alerts';

const cal = { mode: 'month' as 'list' | CalMode, ref: todayStr() };

/** Catalogue des spectacles : en cours / à venir d'abord, terminés ensuite. */
export const showsView: ViewFactory = () => ({
  mount(root) {
    root.innerHTML = `<div class="page"><div class="row shows-head"><h1 class="grow">Spectacles</h1>
      ${can('regisseur_general') ? '<button class="btn primary" data-act="new">+ Nouveau</button>' : ''}</div><div class="chips" role="group" aria-label="Affichage">
        <button class="chip" data-act="vmode" data-v="list">Liste</button><button class="chip" data-act="vmode" data-v="month">Mois</button><button class="chip" data-act="vmode" data-v="week">Semaine</button></div>
      <div id="err" class="sub warn" role="alert"></div><div id="list" class="list"></div></div>`;
    root.addEventListener('click', async (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset;
      if (a?.act === 'vmode') { cal.mode = a.v as typeof cal.mode; paint(root); return; }
      if (a?.act === 'cal-prev' || a?.act === 'cal-next') { cal.ref = shiftRef(cal.ref, cal.mode === 'week' ? 'week' : 'month', a.act === 'cal-next' ? 1 : -1); paint(root); return; }
      if (a?.act === 'cal-today') { cal.ref = todayStr(); paint(root); return; }
      if (a?.act !== 'new') return;
      const today = todayStr();
      const v = await openForm('Nouveau spectacle', [
        { name: 'name', label: 'Nom', required: true },
        { name: 'start', label: 'Début', type: 'date', required: true, value: today },
        { name: 'end', label: 'Fin', type: 'date', required: true, value: today },
        { name: 'note', label: 'Note', type: 'textarea' }
      ], { submit: 'Créer', validate: (x) => (x.end < x.start ? 'La fin doit être après le début.' : null) });
      if (!v) return;
      const id = uuid();
      const r = await rpcCall('create_show', { p_id: id, p_name: v.name, p_start: v.start, p_end: v.end, p_note: v.note || null });
      if (r.error) root.querySelector('#err')!.textContent = r.error; else go(`#/show/${id}`);
    });
    paint(root);
  },
  update: paint
});

function paint(root: HTMLElement) {
  const { shows, showItems, showPosts } = view();
  root.querySelectorAll<HTMLElement>('[data-act="vmode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cal.mode)));
  if (cal.mode !== 'list') { root.querySelector('#list')!.innerHTML = calendarHtml(shows, cal.ref, cal.mode, canActShow, calendarExternals(view())); return; }
  const today = todayStr();
  const alerted = new Set(showAlerts(view(), today).map((a) => a.show.id));
  const n = (id: string) => showItems.filter((s) => s.show_id === id).length;
  const live = shows.filter((s) => s.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = shows.filter((s) => s.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date));
  const row = (s: (typeof shows)[number]) => `<a class="item" href="#/show/${s.id}"><i class="dotc" style="background:${showColor(s)}"></i><div class="grow"><div class="t">${esc(s.name)}</div>
    <div class="s">du ${fmtDay(s.start_date)} au ${fmtDay(s.end_date)} · ${n(s.id)} projecteur${n(s.id) > 1 ? 's' : ''}${showPosts.filter((p) => p.show_id === s.id).length ? ` · ${showPosts.filter((p) => p.show_id === s.id).length} message${showPosts.filter((p) => p.show_id === s.id).length > 1 ? 's' : ''}` : ''}</div></div>
    ${alerted.has(s.id) ? '<span class="tag late">⚠ matériel manquant</span>' : ''}${s.start_date <= today && s.end_date >= today ? '<span class="tag run">en cours</span>' : ''}</a>`;
  root.querySelector('#list')!.innerHTML = shows.length
    ? live.map(row).join('') + (past.length ? `<h2 style="margin-top:18px">Terminés</h2>` + past.map(row).join('') : '')
    : `<div class="empty">Aucun spectacle${can('regisseur_general') ? '' : ' (seuls les régisseurs généraux peuvent en créer)'}</div>`;
}
