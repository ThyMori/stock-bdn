// Mises à jour de l'appli : un bandeau « Nouvelle version disponible » propose de recharger.
// Rien ne se recharge sans toi. La vérification se fait au retour sur l'appli, quand le réseau revient, puis toutes les 30 minutes.
import { registerSW } from 'virtual:pwa-register';

const CHECK_EVERY = 30 * 60 * 1000;   // 30 minutes

export function initUpdates(): void {
  // Le bandeau est créé une fois, caché ; il n'apparaît que quand une nouvelle version est prête.
  const bar = document.createElement('div');
  bar.className = 'update-bar'; bar.setAttribute('role', 'status'); bar.hidden = true;
  const msg = document.createElement('span'); msg.textContent = 'Nouvelle version disponible.';
  const now = document.createElement('button'); now.type = 'button'; now.className = 'btn primary'; now.textContent = 'Mettre à jour';
  const later = document.createElement('button'); later.type = 'button'; later.className = 'btn'; later.textContent = '×'; later.setAttribute('aria-label', 'Plus tard');
  bar.append(msg, now, later);
  document.body.append(bar);

  let registration: ServiceWorkerRegistration | undefined;
  // « immediate » : on enregistre tout de suite le service worker ; onNeedRefresh se déclenche quand une version plus récente attend.
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => { bar.hidden = false; },
    onRegisteredSW: (_url, r) => { registration = r; }
  });

  const check = () => { if (navigator.onLine) registration?.update().catch(() => { /* hors ligne : sans conséquence */ }); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('online', check);
  setInterval(check, CHECK_EVERY);

  now.addEventListener('click', () => { now.disabled = true; void updateSW(true); });   // active la nouvelle version puis recharge la page
  later.addEventListener('click', () => { bar.hidden = true; });                          // le bandeau reviendra à la prochaine vérification
}
