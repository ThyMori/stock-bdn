import type { ViewFactory } from '../router';
import { can, rpcCall, state, view } from '../store';
import { esc, fmtDateTime, uuid } from '../logic';
import { fromEditable, mentionedIds, personColor, renderBody, toEditable } from '../wall';
import { knownPeople, loadPeople } from '../people';
import { openForm } from '../ui/dialog';
import { ALL_OPT, notifyPost } from '../push';
import { showColor } from '../types';

let filter = '';   // '' = tout ; '__general' = infos générales ; sinon id d'un spectacle

/** Mur global : tous les messages de tous les spectacles, avec le spectacle rappelé dans la marge. */
export const murView: ViewFactory = () => ({
  mount(root) {
    root.innerHTML = `<div class="page"><h1>Mur</h1><div id="mhost"></div>
      <label class="f">Afficher<select id="mfilter"></select></label><div id="mlist" class="gposts"></div></div>`;
    if (can('regisseur_general')) {
      const c = document.createElement('div'); c.className = 'composer stack';
      const adm = can('admin');
      c.innerHTML = `<div class="bandeau ${adm ? 'adm' : 'gen'}">${adm ? 'Annonce admin' : 'Info générale'}</div>
        <textarea id="mText" rows="3" maxlength="2000" placeholder="${adm ? 'Annonce à tous : notes de mise à jour, consignes…' : 'Info générale : vie du théâtre, utilisation du matériel…'}" aria-label="Nouveau message général"></textarea>
        <div class="row wrap"><button class="btn" data-act="m-person" type="button">@ Citer une personne</button><button class="btn" data-act="m-item" type="button"># Citer un projecteur</button>
        <button class="btn primary grow" data-act="m-post" type="button">Publier</button></div><div id="mErr" class="sub warn" role="alert"></div>`;
      root.querySelector('#mhost')!.appendChild(c);
    }
    const err = (m: string) => { const x = root.querySelector('#mErr'); if (x) x.textContent = m; };
    root.addEventListener('click', async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]'); if (!el) return;
      const act = el.dataset.act, v = el.dataset.v ?? '';
      const ta = root.querySelector<HTMLTextAreaElement>('#mText');
      const insert = (t: string) => { if (!ta) return; const a = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, a) + t + ta.value.slice(ta.selectionEnd ?? a); ta.focus(); ta.setSelectionRange(a + t.length, a + t.length); };
      if (act === 'm-person') {
        const ppl = (await loadPeople()).filter((p) => p.id !== state.profile?.id);
        if (!ppl.length) { err('Annuaire indisponible (connexion requise).'); return; }
        const f = await openForm('Citer une personne', [{ name: 'p', label: 'Personne', type: 'select', search: true, options: ALL_OPT().concat(ppl.map((p): [string, string] => [p.id, p.label])), required: true }], { submit: 'Citer' });
        if (f) insert(f.p === '@all' ? '@all ' : '@' + (ppl.find((p) => p.id === f.p)?.label ?? '') + ' ');
      } else if (act === 'm-item') {
        const f = await openForm('Citer un projecteur', [{ name: 'n', label: 'N° du projecteur', required: true }], { submit: 'Citer', validate: (x) => (view().items.some((i) => String(i.id) === x.n.trim()) ? null : 'Projecteur inconnu.') });
        if (f) insert('#' + f.n.trim() + ' ');
      } else if (act === 'm-post') {
        if (!ta) return; const text = ta.value.trim(); if (!text) { err('Écris un message avant de publier.'); return; }
        const ppl = knownPeople().length ? knownPeople() : await loadPeople();
        const pid = uuid();
        const r = await rpcCall('post_general_message', { p_id: pid, p_body: fromEditable(text, ppl) });
        if (r.error) err(r.error); else { ta.value = ''; err(''); notifyPost(pid); }
      } else if (act === 'post-edit') {
        const p = view().showPosts.find((x) => x.id === v); if (!p) return;
        const f = await openForm('Modifier le message', [{ name: 'b', label: 'Message', type: 'textarea', required: true, value: toEditable(p.body) }]);
        if (!f) return;
        const r = await rpcCall('edit_show_message', { p_id: p.id, p_body: fromEditable(f.b, knownPeople().length ? knownPeople() : await loadPeople()) });
        if (r.error) err(r.error);
      } else if (act === 'post-del') {
        if (!window.confirm('Effacer ce message ?')) return;
        const r = await rpcCall('delete_show_message', { p_id: v });
        if (r.error) err(r.error);
      }
    });
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
    if (filter && filter !== '__general' && !shows.some((s) => s.id === filter)) filter = '';
    sel.innerHTML = `<option value="">Tout</option><option value="__general" ${filter === '__general' ? 'selected' : ''}>Infos générales (annonces admin et régie générale)</option>` + shows.map((s) => `<option value="${s.id}" ${s.id === filter ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  }
  const myId = state.profile?.id;
  const posts = d.showPosts.filter((p) => !filter || (filter === '__general' ? p.show_id === null : p.show_id === filter)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const list = root.querySelector('#mlist')!;
  list.innerHTML = posts.map((p) => {
    const s = d.shows.find((x) => x.id === p.show_id);
    const me = !!myId && mentionedIds(p.body).includes(myId);
    const general = p.show_id === null, own = !!myId && p.author_id === myId;
    const margin = general
      ? `<div class="margin ${p.kind === 'admin' ? 'adm' : 'gen'}"><span>${p.kind === 'admin' ? 'ANNONCE ADMIN' : 'INFO GÉNÉRALE'}</span></div>`
      : `<a class="margin" style="background:${s ? showColor(s) : '#475569'}" href="#/show/${p.show_id}" aria-label="Spectacle ${esc(s?.name ?? '')}"><span>${esc(s?.name ?? '—')}</span></a>`;
    const tools = general && (own || can('admin')) ? `<div class="row wrap">${own ? `<button class="linkbtn" data-act="post-edit" data-v="${p.id}">Modifier</button>` : ''}<button class="linkbtn" data-act="post-del" data-v="${p.id}">Effacer</button></div>` : '';
    return `<article class="gpost${general ? ' general ' + (p.kind === 'admin' ? 'adm' : 'gen') : ''}">${margin}
      <div class="post${me ? ' tome' : ''}" style="--pc:${personColor(p.author_id)}"><header><b class="who">${esc(p.author_label ?? 'Compte supprimé')}</b>
        <time datetime="${esc(p.created_at)}">${esc(fmtDateTime(p.created_at))}</time>${p.edited_at ? ' <span class="muted">(modifié)</span>' : ''}${me ? ' <span class="tag late">te cite</span>' : ''}</header>
        <div class="body">${renderBody(p.body)}</div>${tools}</div></article>`;
  }).join('') || '<div class="empty">Aucun message pour l\'instant. Les messages des spectacles et les infos générales apparaissent ici.</div>';
}
