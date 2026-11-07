import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { authFlow, configured, supabase } from './supabase';
import { loadLocal, loadProfile, setOnline, setSession, state, subscribe, sync, clearLocal, view } from './store';
import { parseHash } from './router';
import type { View, ViewFactory } from './router';
import { listView } from './views/list';
import { itemView } from './views/item';
import { scanView } from './views/scan';
import { faultsView } from './views/faults';
import { moreView } from './views/more';
import { adminView } from './views/admin';
import { labelsView } from './views/labels';
import { showConfigMissing, showLogin, showSetPassword } from './views/login';
import { can } from './store';
import { fmtDateTime } from './logic';

registerSW({ immediate: true });
const app = document.getElementById('app')!;

const ROUTES: Record<string, { f: ViewFactory; tab: string; min?: 'technicien' | 'admin' }> = {
  '': { f: listView, tab: 'list' }, item: { f: itemView, tab: 'list' }, scan: { f: scanView, tab: 'scan' },
  faults: { f: faultsView, tab: 'faults' }, more: { f: moreView, tab: 'more' },
  labels: { f: labelsView, tab: 'more', min: 'technicien' }, admin: { f: adminView, tab: 'more', min: 'admin' }
};

const ICON = {
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
  faults: '<path d="M12 3 2.5 20h19L12 3zM12 10v4M12 17v.5"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'
};
const tabLink = (key: keyof typeof ICON, href: string, label: string, cur: string, badge = 0) =>
  `<a href="${href}" ${cur === key ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[key]}</svg>${label}${badge ? `<span class="n">${badge}</span>` : ''}</a>`;

let current: { view: View; root: HTMLElement; cleanup?: void | (() => void) } | null = null;

function shell() {
  app.innerHTML = `<div id="status"></div><main id="view"></main><nav class="tabs"><div class="in" id="tabs"></div></nav>`;
}

function paintStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  const wait = state.pending.length;
  const label = state.syncing ? 'Synchronisation…' : !navigator.onLine ? `Hors ligne${wait ? ` · ${wait} en attente` : ''}` : wait ? `${wait} en attente` : 'À jour';
  el.innerHTML = `<div class="topbar"><span class="brand">Stock BdN</span>
      <button class="sync ${!navigator.onLine ? 'off' : state.syncing ? 'busy' : ''}" id="syncBtn" title="${state.lastPull ? 'Dernière mise à jour ' + fmtDateTime(state.lastPull) : ''}">${label}</button></div>
    ${state.rejected.length ? `<div class="banner err">${state.rejected.length} action(s) refusée(s) par le serveur — <a href="#/more">voir</a></div>` : ''}
    ${state.error && navigator.onLine ? `<div class="banner">Synchro en échec : ${state.error}</div>` : ''}`;
  el.querySelector('#syncBtn')?.addEventListener('click', () => void sync());
}

function paintTabs(tab: string) {
  const open = view().faults.filter((f) => !f.resolved_at).length;
  const el = document.getElementById('tabs');
  if (el) el.innerHTML = tabLink('list', '#/', 'Parc', tab) + tabLink('scan', '#/scan', 'Scan', tab) + tabLink('faults', '#/faults', 'Pannes', tab, open) + tabLink('more', '#/more', 'Plus', tab);
}

function route() {
  current?.cleanup && (current.cleanup as () => void)();
  current = null;
  const { segs, query } = parseHash();
  let r = ROUTES[segs[0] ?? ''] ?? ROUTES[''];
  if (r.min && !can(r.min)) r = ROUTES.more;
  const root = document.createElement('div');
  const host = document.getElementById('view')!;
  host.replaceChildren(root);
  const v = r.f(segs.slice(1), query);
  current = { view: v, root, cleanup: v.mount(root) };
  window.scrollTo(0, 0);
  paintTabs(r.tab);
  document.body.dataset.tab = r.tab;
}

function startApp() {
  shell();
  subscribe(() => {
    paintStatus();
    paintTabs(document.body.dataset.tab ?? 'list');
    current?.view.update?.(current.root);
  });
  window.addEventListener('hashchange', route);
  paintStatus();
  route();
  void sync();
}

window.addEventListener('online', () => { setOnline(true); void sync(); });
window.addEventListener('offline', () => setOnline(false));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync(); });

async function boot() {
  if (!configured) return showConfigMissing(app);
  await loadLocal();

  supabase.auth.onAuthStateChange((event, session) => {
    setSession(session);
    if (event === 'SIGNED_OUT') void clearLocal().then(() => location.reload());
  });

  const finish = async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    if (data.session && !state.profile) await loadProfile(data.session.user.id).catch(() => {});
    else if (data.session) void loadProfile(data.session.user.id).catch(() => {});
    startApp();
  };
  const login = () => showLogin(app, () => { void clearAndStart(); });
  // Après connexion : on repart d'un cache propre pour ne pas mélanger deux comptes sur le même appareil.
  const clearAndStart = async () => {
    const { data } = await supabase.auth.getSession();
    if (state.profile && data.session && state.profile.id !== data.session.user.id) await clearLocal();
    await loadProfile(data.session!.user.id).catch(() => {});
    await finish();
  };

  const { data } = await supabase.auth.getSession();
  if (data.session && authFlow) return showSetPassword(app, () => { void finish(); });
  if (data.session) return void finish();
  // Pas de session : mode hors ligne autorisé seulement si l'appareil a déjà été connecté puis perdu le réseau.
  if (!navigator.onLine && state.profile && state.data.items.length) { startApp(); return; }
  login();
}

void boot();
