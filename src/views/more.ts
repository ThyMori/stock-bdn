import type { ViewFactory } from '../router';
import { can, clearLocal, dismissRejected, state, sync } from '../store';
import { esc, fmtDateTime } from '../logic';
import { ROLE_LABEL } from '../types';
import { supabase } from '../supabase';

export const moreView: ViewFactory = () => ({
  mount(root) {
    root.addEventListener('click', async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'sync') void sync();
      if (el.dataset.act === 'dismiss') void dismissRejected(Number(el.dataset.v));
      if (el.dataset.act === 'logout') {
        if (state.pending.length && !window.confirm(`${state.pending.length} action(s) ne sont pas encore synchronisées et seront perdues. Se déconnecter quand même ?`)) return;
        await supabase.auth.signOut();
        await clearLocal();
        location.hash = '#/';
        location.reload();
      }
    });
    paint(root);
  },
  update: paint
});

function paint(root: HTMLElement) {
  const p = state.profile;
  root.innerHTML = `<div class="page"><h1>Plus</h1>
    <div class="card stack">
      <div><div class="t">${esc(p?.email ?? '—')}</div><div class="sub">${p ? ROLE_LABEL[p.role] : ''}</div></div>
      <div class="sub">${state.lastPull ? 'Dernière mise à jour : ' + fmtDateTime(state.lastPull) : 'Jamais synchronisé'} · ${state.pending.length} action(s) en attente</div>
      <div class="row"><button class="btn grow" data-act="sync" ${state.online ? '' : 'disabled'}>${state.syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}</button></div>
    </div>
    ${state.rejected.length ? `<div class="card stack"><h2 class="warn">Actions refusées par le serveur</h2>
      ${state.rejected.map((r, i) => `<div class="row"><div class="grow sub">${esc(r.op.kind)} — ${esc(r.message)}</div><button class="btn small" data-act="dismiss" data-v="${i}">OK</button></div>`).join('')}</div>` : ''}
    <div class="list">
      ${can('technicien') ? '<a class="item" href="#/labels"><div class="grow"><div class="t">Étiquettes QR</div><div class="s">Imprimer les stickers des projecteurs</div></div>›</a>' : ''}
      ${can('admin') ? `
        <a class="item" href="#/admin/items"><div class="grow"><div class="t">Ajouter des projecteurs</div><div class="s">Nouvelles unités dans le parc</div></div>›</a>
        <a class="item" href="#/admin/models"><div class="grow"><div class="t">Modèles</div><div class="s">Catalogue des références</div></div>›</a>
        <a class="item" href="#/admin/lamps"><div class="grow"><div class="t">Lampes</div><div class="s">Références et puissances</div></div>›</a>
        <a class="item" href="#/admin/refs"><div class="grow"><div class="t">Familles, types, douilles, porte-filtres</div></div>›</a>
        <a class="item" href="#/admin/users"><div class="grow"><div class="t">Utilisateurs et droits</div></div>›</a>` : ''}
    </div>
    <button class="btn danger" data-act="logout">Se déconnecter</button>
    <div class="sub" style="text-align:center">Stock BdN · v1.0</div></div>`;
}
