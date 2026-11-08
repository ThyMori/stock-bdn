import type { ViewFactory } from '../router';
import { go } from '../router';
import { can, rpcCall, view } from '../store';
import { esc, todayStr, uuid } from '../logic';
import { openForm } from '../ui/dialog';
import { fmtDay } from './agenda';

/** Catalogue des spectacles : en cours / à venir d'abord, terminés ensuite. */
export const showsView: ViewFactory = () => ({
  mount(root) {
    root.innerHTML = `<div class="page"><div class="row"><h1 class="grow">Spectacles</h1>
      ${can('regisseur_general') ? '<button class="btn primary" data-act="new">+ Nouveau</button>' : ''}</div><div id="err" class="sub warn" role="alert"></div><div id="list" class="list"></div></div>`;
    root.addEventListener('click', async (e) => {
      if (!(e.target as HTMLElement).closest('[data-act="new"]')) return;
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
  const { shows, showItems } = view();
  const today = todayStr();
  const n = (id: string) => showItems.filter((s) => s.show_id === id).length;
  const live = shows.filter((s) => s.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const past = shows.filter((s) => s.end_date < today).sort((a, b) => b.end_date.localeCompare(a.end_date));
  const row = (s: (typeof shows)[number]) => `<a class="item" href="#/show/${s.id}"><div class="grow"><div class="t">${esc(s.name)}</div>
    <div class="s">du ${fmtDay(s.start_date)} au ${fmtDay(s.end_date)} · ${n(s.id)} projecteur${n(s.id) > 1 ? 's' : ''}</div></div>
    ${s.start_date <= today && s.end_date >= today ? '<span class="tag run">en cours</span>' : ''}</a>`;
  root.querySelector('#list')!.innerHTML = shows.length
    ? live.map(row).join('') + (past.length ? `<h2 style="margin-top:18px">Terminés</h2>` + past.map(row).join('') : '')
    : `<div class="empty">Aucun spectacle${can('regisseur_general') ? '' : ' (seuls les régisseurs généraux peuvent en créer)'}</div>`;
}
