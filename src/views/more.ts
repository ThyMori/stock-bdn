import type { ViewFactory } from '../router';
import { can, clearLocal, dismissRejected, loadProfile, rpcCall, state, sync } from '../store';
import { openForm } from '../ui/dialog';
import { esc, fmtDateTime } from '../logic';
import { ROLE_LABEL, fullName } from '../types';
import { supabase } from '../supabase';
import { disablePush, enablePush, forgetPushOnLogout, pushStatus, testPush } from '../push';
import type { PushStatus } from '../push';

let pushSt: PushStatus | null = null;
const refreshPush = async (root: HTMLElement) => {
  const uid = state.session?.user.id;
  pushSt = uid ? await pushStatus(uid) : null;
  if (root.isConnected) paint(root);
};

export const moreView: ViewFactory = () => ({
  mount(root) {
    void refreshPush(root);
    root.addEventListener('click', async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'sync') void sync();
      if (el.dataset.act === 'rename' && state.profile) {
        const p = state.profile;
        const f = await openForm('Mon profil', [
          { name: 'first', label: 'Prénom', required: true, value: p.first_name ?? '' },
          { name: 'last', label: 'Nom', required: true, value: p.last_name ?? '' }
        ], { validate: (x) => (x.first.trim() && x.last.trim() ? null : 'Prénom et nom obligatoires.') });
        if (!f) return;
        const r = await rpcCall('set_my_name', { p_first: f.first, p_last: f.last });
        if (r.error) { const x = root.querySelector('#profErr'); if (x) x.textContent = r.error; return; }
        await loadProfile(p.id).catch(() => {});
        paint(root);
      }
      const uid = state.session?.user.id;
      if (uid && (el.dataset.act === 'push-on' || el.dataset.act === 'push-off' || el.dataset.act === 'push-test')) {
        const msg = (t: string) => { const m = root.querySelector('#pushMsg'); if (m) m.textContent = t; };
        (el as HTMLButtonElement).disabled = true;
        if (el.dataset.act === 'push-on') { const err = await enablePush(uid); await refreshPush(root); if (err) msg(err); }
        else if (el.dataset.act === 'push-off') { const err = await disablePush(uid); await refreshPush(root); if (err) msg(err); }
        else { msg('Envoi…'); const t = await testPush(); (el as HTMLButtonElement).disabled = false; msg(t); }
      }
      if (el.dataset.act === 'dismiss') void dismissRejected(Number(el.dataset.v));
      if (el.dataset.act === 'logout') {
        if (state.pending.length && !window.confirm(`${state.pending.length} action(s) ne sont pas encore synchronisées et seront perdues. Se déconnecter quand même ?`)) return;
        await forgetPushOnLogout();
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
      <div><div class="t">${esc(p ? fullName(p) : '—')}</div><div class="sub">${p ? ROLE_LABEL[p.role] + (fullName(p) !== p.email ? ' · ' + esc(p.email) : '') : ''}</div></div>
      <div class="row wrap"><button class="btn" data-act="rename" ${state.online ? '' : 'disabled'}>Modifier mon nom</button></div><div id="profErr" class="sub warn" role="alert"></div>
      <div class="sub">${state.lastPull ? 'Dernière mise à jour : ' + fmtDateTime(state.lastPull) : 'Jamais synchronisé'} · ${state.pending.length} action(s) en attente</div>
      <div class="row"><button class="btn grow" data-act="sync" ${state.online ? '' : 'disabled'}>${state.syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}</button></div>
    </div>
    ${state.rejected.length ? `<div class="card stack"><h2 class="warn">Actions refusées par le serveur</h2>
      ${state.rejected.map((r, i) => `<div class="row"><div class="grow sub">${esc(r.op.kind)} — ${esc(r.message)}</div><button class="btn small" data-act="dismiss" data-v="${i}">OK</button></div>`).join('')}</div>` : ''}
    ${pushCard()}
    <div class="list">
      ${can('regisseur_general') ? '<a class="item" href="#/labels"><div class="grow"><div class="t">Étiquettes QR</div><div class="s">Imprimer les stickers des projecteurs</div></div>›</a>' : ''}
      ${can('regisseur_general') ? `
        <a class="item" href="#/admin/items"><div class="grow"><div class="t">Ajouter des projecteurs</div><div class="s">Nouvelles unités dans le parc</div></div>›</a>
        <a class="item" href="#/admin/users"><div class="grow"><div class="t">Utilisateurs et droits</div></div>›</a>` : ''}
      ${can('admin') ? `
        <a class="item" href="#/log"><div class="grow"><div class="t">Journal</div><div class="s">Activité en temps réel</div></div>›</a>
        <a class="item" href="#/admin/models"><div class="grow"><div class="t">Modèles</div><div class="s">Catalogue des références</div></div>›</a>
        <a class="item" href="#/admin/lamps"><div class="grow"><div class="t">Lampes</div><div class="s">Références et puissances</div></div>›</a>
        <a class="item" href="#/admin/refs"><div class="grow"><div class="t">Familles, types, douilles, porte-filtres</div></div>›</a>` : ''}
    </div>
    <button class="btn danger" data-act="logout">Se déconnecter</button>
    <div class="sub" style="text-align:center">Stock BdN · v1.12.3</div></div>`;
}

function pushCard(): string {
  if (pushSt === null) return '';
  const off = state.online ? '' : 'disabled';
  const info = '<div class="sub">Tu es prévenu des messages de tous les spectacles si tu es régisseur général ou admin, sinon de ceux qui te concernent (assigné, créateur, déjà intervenu sur leur mur), quand quelqu’un te cite (@), et quand un régisseur général / un administrateur écrit @all. Les annonces admin et infos générales restent silencieuses, sauf si tu es cité.</div>';
  const body: Record<PushStatus, string> = {
    unsupported: '<div class="sub">Ce navigateur ne gère pas les notifications.</div>',
    'ios-install': '<div class="sub">Sur iPhone, ajoute d’abord l’appli à l’écran d’accueil (Partager → Sur l’écran d’accueil), puis ouvre-la depuis son icône : les notifications y seront disponibles.</div>',
    denied: '<div class="sub warn" style="display:block">Les notifications sont bloquées pour cette appli. Autorise-les dans les réglages du navigateur ou du téléphone, puis reviens ici.</div>',
    off: `${info}<div class="row"><button class="btn grow" data-act="push-on" ${off}>Activer les notifications</button></div>`,
    on: `${info}<div class="sub"><b>Activées sur cet appareil.</b></div><div class="row wrap"><button class="btn grow" data-act="push-test" ${off}>Envoyer un essai</button><button class="btn grow" data-act="push-off" ${off}>Désactiver</button></div>`
  };
  return `<div class="card stack"><h2>Notifications</h2>${body[pushSt]}<div id="pushMsg" class="sub" role="status"></div></div>`;
}
