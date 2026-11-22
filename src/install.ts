// Installation de l'appli (écran d'accueil) : détection de la plateforme, rappel reportable et guide pas à pas.
// - Chrome / Edge / Android : le navigateur envoie « beforeinstallprompt » ; le bouton Installer ouvre la fenêtre native.
// - iPhone / iPad (Safari), Safari sur Mac, Firefox Android : pas d'installation par programme : on affiche le guide.
// - Déjà installée (ouverte en mode application) : rien n'est proposé.
// - « Plus tard » reporte le rappel d'une semaine ; après 3 reports il ne revient plus tout seul (Plus → Installer reste disponible).

interface InstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
export type Platform = 'ios' | 'android' | 'firefox-desktop' | 'mac-safari' | 'desktop-chromium';

const KEY = 'stockbdn:install';
const SNOOZE_MS = 7 * 24 * 3600 * 1000, MAX_SNOOZES = 3;
interface State { installed?: boolean; until?: number; count?: number }
const load = (): State => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') || {}; } catch { return {}; } };
const save = (patch: State) => { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...patch })); } catch { /* stockage indisponible : le rappel reviendra */ } };
const changed = () => window.dispatchEvent(new Event('install-changed'));   // les écrans se mettent à jour

export function detectPlatform(): Platform {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';   // iPadOS se présente comme un Mac
  if (/Android/.test(ua)) return 'android';
  if (/Firefox\//.test(ua)) return 'firefox-desktop';
  if (/Macintosh/.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua)) return 'mac-safari';
  return 'desktop-chromium';
}
export function isStandalone(): boolean {
  const m = (q: string) => !!window.matchMedia && window.matchMedia(q).matches;
  return m('(display-mode: standalone)') || m('(display-mode: fullscreen)') || m('(display-mode: minimal-ui)') || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

const platform = detectPlatform();
let deferred: InstallPromptEvent | null = null;   // événement « beforeinstallprompt » mis de côté

export const isInstalled = (): boolean => isStandalone() || load().installed === true;
/** Peut-on installer ? (Firefox sur ordinateur ne sait pas.) */
export const canInstall = (): boolean => !isInstalled() && platform !== 'firefox-desktop';
/** Faut-il afficher le bandeau d'invitation ? */
export function installBannerWanted(): boolean {
  const s = load();
  return canInstall() && (s.count ?? 0) < MAX_SNOOZES && Date.now() >= (s.until ?? 0);
}
export const installButtonLabel = (): string => (deferred ? 'Installer' : 'Voir comment');
export function snoozeInstall(): void { save({ until: Date.now() + SNOOZE_MS, count: (load().count ?? 0) + 1 }); changed(); }

/** Écoute les événements du navigateur ; à appeler une fois au démarrage. */
export function initInstall(): void {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; save({ installed: false }); changed(); });   // on affiche notre propre invitation
  window.addEventListener('appinstalled', () => { deferred = null; save({ installed: true }); closeGuide(); changed(); });
  // Chrome / Edge : détecte une installation faite plus tôt quand on ouvre le site dans un onglet
  const nav = navigator as unknown as { getInstalledRelatedApps?: () => Promise<unknown[]> };
  nav.getInstalledRelatedApps?.().then((apps) => { if (apps?.length && !deferred) { save({ installed: true }); changed(); } }).catch(() => { /* non pris en charge */ });
}

/** Installe directement quand le navigateur le permet, sinon ouvre le guide. */
export async function promptInstall(): Promise<void> {
  if (!deferred) return openGuide();
  const ev = deferred; deferred = null;   // l'événement ne sert qu'une fois
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    if (choice.outcome === 'accepted') save({ installed: true }); else snoozeInstall();
  } catch { /* fenêtre fermée ou refusée : on n'insiste pas */ }
  closeGuide(); changed();
}

const SECTIONS: { id: Platform; title: string; steps: string[] }[] = [
  { id: 'ios', title: 'iPhone et iPad', steps: ['Ouvre Stock BdN dans <b>Safari</b>.', 'Touche le bouton <b>Partager</b> (le carré avec une flèche vers le haut), en bas de l’écran.', 'Fais défiler et touche <b>Sur l’écran d’accueil</b>.', 'Touche <b>Ajouter</b>. L’icône Stock BdN apparaît sur ton écran d’accueil : ouvre l’appli depuis là.'] },
  { id: 'android', title: 'Téléphone Android', steps: ['Ouvre Stock BdN dans <b>Chrome</b> ou <b>Firefox</b>.', 'Touche le menu <b>⋮</b> (en haut à droite sur Chrome, en bas ou en haut sur Firefox).', 'Touche <b>Installer l’application</b> (ou <b>Installer</b>, ou <b>Ajouter à l’écran d’accueil</b>), puis confirme.'] },
  { id: 'desktop-chromium', title: 'Ordinateur : Chrome, Edge, Brave', steps: ['Dans la barre d’adresse, à droite, clique sur l’icône <b>Installer</b> (un écran avec une flèche).', 'Si tu ne la vois pas : menu <b>⋮</b> puis <b>Installer Stock BdN</b> (ou <b>Enregistrer et partager</b> puis <b>Installer</b> sur Chrome).', 'Confirme. L’appli s’ouvre dans sa propre fenêtre et s’ajoute à tes applications.'] },
  { id: 'mac-safari', title: 'Mac : Safari', steps: ['Dans la barre de menus, clique sur <b>Fichier</b>.', 'Choisis <b>Ajouter au Dock</b>, puis confirme.'] },
  { id: 'firefox-desktop', title: 'Ordinateur : Firefox', steps: ['Firefox ne permet pas d’installer des applications web sur ordinateur. Ouvre Stock BdN dans Chrome, Edge ou Safari pour l’installer, ou épingle simplement l’onglet.'] }
];

let guide: HTMLDialogElement | null = null;
function closeGuide(): void { if (guide?.open) guide.close(); guide?.remove(); guide = null; }

/** Guide d'installation pas à pas : l'appareil de la personne passe en premier et s'ouvre. Contenu fixe (aucun texte venant d'un utilisateur). */
export function openGuide(): void {
  closeGuide();
  const d = document.createElement('dialog'); d.className = 'dlg install-guide';
  const order = [...SECTIONS].sort((a, b) => Number(b.id === platform) - Number(a.id === platform));
  d.innerHTML = `<div class="stack"><h2 tabindex="-1">Installer Stock BdN</h2>
    <p class="sub">Installée, l’appli s’ouvre en plein écran depuis ton écran d’accueil, sans passer par le navigateur.</p>
    ${deferred ? '<button type="button" class="btn primary" data-i="now">Installer maintenant</button>' : ''}
    ${order.map((s) => `<details ${s.id === platform ? 'open' : ''}><summary><b>${s.title}</b>${s.id === platform ? ' <span class="tag run">ton appareil</span>' : ''}</summary>${s.steps.length > 1 ? `<ol>${s.steps.map((x) => `<li>${x}</li>`).join('')}</ol>` : `<p>${s.steps[0]}</p>`}</details>`).join('')}
    <button type="button" class="btn" data-i="close">Fermer</button></div>`;
  d.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]'); if (!b) return;
    if (b.dataset.i === 'close') closeGuide(); else void promptInstall();
  });
  d.addEventListener('close', () => { if (guide === d) { d.remove(); guide = null; } });
  document.body.append(d); guide = d; d.showModal();
  d.querySelector<HTMLElement>('h2')?.focus();
}
