// Garde-fou de démarrage : si rien n'est affiché après 8 s, on montre l'erreur et un bouton de secours.

/** Efface tout ce qui est local (service worker, caches, données) puis recharge l'appli. */
export async function resetAndReload(): Promise<void> {
  try { for (const r of await navigator.serviceWorker?.getRegistrations() ?? []) await r.unregister(); } catch { /* ignore */ }
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  try { for (const d of await indexedDB.databases?.() ?? []) if (d.name) indexedDB.deleteDatabase(d.name); } catch { /* ignore */ }
  location.replace(location.pathname);   // recharge sans le #/ de l'ancienne page
}

/** Lance la surveillance : si #app est encore vide après `ms`, affiche le message de secours. */
export function startWatchdog(app: HTMLElement, ms = 8000): void {
  setTimeout(() => {
    if (app.innerHTML.trim() !== '') return;   // l'appli a démarré : rien à faire
    app.innerHTML = `<div class="login"><div class="card stack"><h1 class="hero">Stock BdN</h1>
      <div class="sub warn" role="alert">L'application n'a pas démarré. Appuie sur le bouton pour la réinitialiser (tes données sont conservées sur le serveur).</div>
      <button class="btn primary" id="wd-reset">Réinitialiser et recharger</button></div></div>`;
    app.querySelector('#wd-reset')!.addEventListener('click', () => { void resetAndReload(); });
  }, ms);
}
