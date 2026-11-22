import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { authFlow, configured, supabase } from './supabase';
import { loadLocal, loadProfile, setOnline, setSession, state, subscribe, sync, clearLocal, view } from './store';
import { parseHash } from './router';
import type { View, ViewFactory } from './router';
import { listView } from './views/list';
import { itemView } from './views/item';
import { scanView } from './views/scan';
import { faultsView } from './views/faults';
import { faultView } from './views/fault';
import { showsView } from './views/shows';
import { murView } from './views/mur';
import { showView } from './views/show';
import { logView } from './views/log';
import { UPDATE_PENDING } from './flags';
import { alertText, showAlerts } from './alerts';
import { esc, todayStr } from './logic';
import { showColor } from './types';
import { moreView } from './views/more';
import { adminView } from './views/admin';
import { labelsView } from './views/labels';
import { showConfigMissing, showLogin, showSetPassword } from './views/login';
import { can } from './store';
import { playArc, reducedMotion } from './arc';
import { playPinball } from './pinball';
import type { Role } from './types';
import { fmtDateTime } from './logic';
import { enablePush, listenPushNavigation, notifBannerWanted, snoozeNotifBanner, syncPush } from './push';
import { toast } from './ui/toast';
import { initInstall, installBannerWanted, installButtonLabel, promptInstall, snoozeInstall } from './install';
import { initUpdates } from './updates';
import { startWatchdog } from './watchdog';
import { onlineNames, startPresence } from './presence';

initUpdates();
document.addEventListener('gesturestart', (e) => e.preventDefault());   // iOS : pas de zoom au pincement
const app = document.getElementById('app')!;
startWatchdog(app);   // si l'écran reste vide 8 s : erreur + « Réinitialiser et recharger »

const ROUTES: Record<string, { f: ViewFactory; tab: string; min?: Role }> = {
  '': { f: listView, tab: 'list' }, item: { f: itemView, tab: 'list' }, scan: { f: scanView, tab: 'scan' },
  mur: { f: murView, tab: 'mur' },
  shows: { f: showsView, tab: 'shows' }, show: { f: showView, tab: 'shows' },
  faults: { f: faultsView, tab: 'faults' }, fault: { f: faultView, tab: 'faults' }, log: { f: logView, tab: 'more', min: 'admin' }, more: { f: moreView, tab: 'more' },
  labels: { f: labelsView, tab: 'more', min: 'regisseur_general' }, admin: { f: adminView, tab: 'more', min: 'regisseur_general' }
};

const ICON = {
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
  shows: '<path d="M3 7h18v10H3zM7 7v10M3 12h4M17 7v10M17 12h4"/>',
  mur: '<path d="M4 5h16v11H9l-5 4z"/>',
  faults: '<path d="M12 3 2.5 20h19L12 3zM12 10v4M12 17v.5"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'
};
const tabLink = (key: keyof typeof ICON, href: string, label: string, cur: string, badge = 0) =>
  `<a href="${href}" ${cur === key ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[key]}</svg>${label}${badge ? `<span class="n">${badge}</span>` : ''}</a>`;

let current: { view: View; root: HTMLElement; cleanup?: void | (() => void) } | null = null;

function shell() {
  app.innerHTML = `${UPDATE_PENDING ? '<div class="update-note" role="status">update en cours</div>' : ''}<div id="status"></div><main id="view"></main><nav class="tabs"><div class="in" id="tabs"></div></nav>`;
}

let notifBanner = false;   // faut-il afficher le bandeau « active les notifications » ?
async function refreshNotifBanner() {
  const uid = state.session?.user.id;
  const want = uid ? await notifBannerWanted(uid).catch(() => false) : false;
  if (want !== notifBanner) { notifBanner = want; paintStatus(); }
}

/** Petit rappel du (des) spectacle(s) en cours aujourd'hui : un appui ouvre sa fiche. */
function nowBanner(): string {
  const today = todayStr();
  const on = view().shows.filter((s) => s.start_date <= today && s.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name));
  const fmt = (d: string) => d.split('-').reverse().join('/');
  return on.slice(0, 2).map((s) => `<a class="banner now" style="--c:${showColor(s)}" href="#/show/${s.id}" aria-label="Spectacle en cours : ${esc(s.name)}, ouvrir sa fiche"><span class="grow">En cours : <b>${esc(s.name)}</b> · jusqu'au ${fmt(s.end_date)}</span><span aria-hidden="true">›</span></a>`).join('')
    + (on.length > 2 ? `<a class="banner now" href="#/shows">+ ${on.length - 2} autre${on.length > 3 ? 's' : ''} spectacle${on.length > 3 ? 's' : ''} en cours ›</a>` : '');
}

let onlineOpen = false;   // liste des personnes en ligne dépliée ?
function paintStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  const wait = state.pending.length;
  const label = state.syncing ? 'Synchronisation…' : !navigator.onLine ? `Hors ligne${wait ? ` · ${wait} en attente` : ''}` : wait ? `${wait} en attente` : 'À jour';
  const on = onlineNames();   // personnes en ligne : pastille verte avec leur nombre, un appui affiche les noms
  el.innerHTML = `<div class="stickyhead"><div class="topbar"><span class="brand">Stock BdN</span><span class="row" style="gap:8px">
      ${on.length ? `<button class="online" id="onlineBtn" aria-expanded="${onlineOpen}" aria-label="${on.length} personne${on.length > 1 ? 's' : ''} en ligne"><i></i>${on.length}</button>` : ''}
      <button class="sync ${!navigator.onLine ? 'off' : state.syncing ? 'busy' : ''}" id="syncBtn" title="${state.lastPull ? 'Dernière mise à jour ' + fmtDateTime(state.lastPull) : ''}">${label}</button></span></div>
    ${onlineOpen && on.length ? `<div class="banner online-list" role="status"><b>En ligne</b> · ${on.map(esc).join(', ')}</div>` : ''}
    ${nowBanner()}</div>
    ${showAlerts(view(), todayStr()).slice(0, 3).map((a) => `<a class="banner alarm" href="#/show/${a.show.id}" role="alert"><b>⚠ ALERTE MATÉRIEL · ${esc(a.show.name)}</b><br>${esc(alertText(a))} — à réparer, louer ou emprunter</a>`).join('')}
    ${installBannerWanted() ? `<div class="banner install" role="region" aria-label="Installer l'application"><img src="${import.meta.env.BASE_URL}icon-192.png" alt="" width="40" height="40"><span class="grow"><b>Installe Stock BdN</b><br>Un accès en un geste depuis ton écran d'accueil, en plein écran, comme une vraie appli.</span><span class="row"><button class="btn primary" data-act="inst-now">${installButtonLabel()}</button><button class="btn" data-act="inst-later">Plus tard</button></span></div>` : ''}
    ${notifBanner && !installBannerWanted() ? `<div class="banner notif" role="region" aria-label="Notifications"><span>Les notifications sont désactivées : tu ne seras pas prévenu quand on te cite ou quand un message arrive sur un de tes spectacles.</span><span class="row"><button class="btn primary" data-act="notif-on">Activer</button><button class="btn" data-act="notif-later">Plus tard</button></span></div>` : ''}
    ${state.rejected.length ? `<div class="banner err">${state.rejected.length} action(s) refusée(s) par le serveur — <a href="#/more">voir</a></div>` : ''}
    ${state.error && navigator.onLine ? `<div class="banner">Synchro en échec : ${state.error}</div>` : ''}`;
  el.querySelector('#syncBtn')?.addEventListener('click', () => void sync());
  el.querySelector('#onlineBtn')?.addEventListener('click', () => { onlineOpen = !onlineOpen; paintStatus(); });
  el.querySelector('[data-act=inst-now]')?.addEventListener('click', () => void promptInstall());
  el.querySelector('[data-act=inst-later]')?.addEventListener('click', () => snoozeInstall());
  el.querySelector('[data-act=notif-later]')?.addEventListener('click', () => { snoozeNotifBanner(); notifBanner = false; paintStatus(); });
  el.querySelector('[data-act=notif-on]')?.addEventListener('click', async () => {
    const uid = state.session?.user.id; if (!uid) return;
    const err = await enablePush(uid);   // demande l'autorisation puis abonne l'appareil
    if (err) toast(err); else toast('Notifications activées.', 'ok');
    void refreshNotifBanner();
  });
}

function paintTabs(tab: string) {
  const open = view().faults.filter((f) => !f.resolved_at).length;
  const el = document.getElementById('tabs');
  if (el) el.innerHTML = tabLink('list', '#/', 'Parc', tab) + tabLink('scan', '#/scan', 'Scan', tab) + tabLink('shows', '#/shows', 'Spectacles', tab) + tabLink('mur', '#/mur', 'Mur', tab) + tabLink('faults', '#/faults', 'Pannes', tab, open) + tabLink('more', '#/more', 'Plus', tab);
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
  // Animations d'arcade à l'ouverture des onglets Pannes (arc électrique) et Plus (flipper).
  const FX: Record<string, (done: () => void) => void> = { '#/faults': playArc, '#/more': playPinball };
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('nav.tabs a');
    const href = a?.getAttribute('href') ?? '';
    if (!a || !FX[href] || a.getAttribute('aria-current') === 'page' || reducedMotion()) return;
    e.preventDefault();
    FX[href](() => { location.hash = href; });
  });
  paintStatus();
  route();
  void sync();
  listenPushNavigation();
  if (state.session) { void syncPush(state.session.user.id); startPresence(); }
  void refreshNotifBanner();
}

window.addEventListener('online', () => { setOnline(true); void sync(); });
window.addEventListener('offline', () => setOnline(false));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void sync(); void refreshNotifBanner(); } });
window.addEventListener('push-changed', () => void refreshNotifBanner());
window.addEventListener('install-changed', () => paintStatus());
window.addEventListener('presence-changed', () => paintStatus());   // la pastille « en ligne » suit   // installée / reportée : le bandeau suit
initInstall();   // activé / désactivé depuis Plus ou depuis le bandeau

async function boot() {
  if (!configured) return showConfigMissing(app);
  await loadLocal();

  supabase.auth.onAuthStateChange((event, session) => {
    setSession(session);
    // Déconnexion : un seul rechargement (celui du bouton « Se déconnecter » s'en charge déjà s'il l'a déclenchée).
    if (event === 'SIGNED_OUT' && !sessionStorage.getItem('logging-out')) void clearLocal().then(() => location.reload());
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
