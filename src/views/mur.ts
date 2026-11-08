import type { ViewFactory } from '../router';
import { state, view } from '../store';
import { esc, fmtDateTime } from '../logic';
import { mentionedIds, personColor, renderBody } from '../wall';
import { showColor } from '../types';

let filter = '';   // '' = tous les spectacles

/** Mur global : tous les messages de tous les spectacles, avec le spectacle rappelé dans la marge. */
export const murView: ViewFactory = () => ({
  mount(root) {
    root.innerHTML = `<div class="page"><h1>Mur</h1>
      <label class="f">Spectacle<select id="mfilter"></select></label><div id="mlist" class="gposts"></div></div>`;
    root.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.id === 'mfilter') { filter = t.value; paint(root); }
    });
    paint(root);
  },
  update: paint
});

function paint(root: HTMLElement) {
  const d = view();
  const sel = root.querySelector<HTMLSelectElement>('#mfilter');
  if (sel) {
    const shows = [...d.shows].sort((a, b) => b.start_date.localeCompare(a.start_date));
    if (filter && !shows.some((s) => s.id === filter)) filter = '';
    sel.innerHTML = `<option value="">Tous les spectacles</option>` + shows.map((s) => `<option value="${s.id}" ${s.id === filter ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  }
  const myId = state.profile?.id;
  const posts = d.showPosts.filter((p) => !filter || p.show_id === filter).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const list = root.querySelector('#mlist')!;
  list.innerHTML = posts.map((p) => {
    const s = d.shows.find((x) => x.id === p.show_id);
    const me = !!myId && mentionedIds(p.body).includes(myId);
    return `<article class="gpost"><a class="margin" style="background:${s ? showColor(s) : '#475569'}" href="#/show/${p.show_id}" aria-label="Spectacle ${esc(s?.name ?? '')}"><span>${esc(s?.name ?? '—')}</span></a>
      <div class="post${me ? ' tome' : ''}" style="--pc:${personColor(p.author_id)}"><header><b class="who">${esc(p.author_label ?? 'Compte supprimé')}</b>
        <time datetime="${esc(p.created_at)}">${esc(fmtDateTime(p.created_at))}</time>${p.edited_at ? ' <span class="muted">(modifié)</span>' : ''}${me ? ' <span class="tag late">te cite</span>' : ''}</header>
        <div class="body">${renderBody(p.body)}</div></div></article>`;
  }).join('') || '<div class="empty">Aucun message pour l\'instant. Écris sur le mur d\'un spectacle pour qu\'il apparaisse ici.</div>';
}
