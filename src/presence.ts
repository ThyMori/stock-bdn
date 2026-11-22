// Personnes en ligne : un signe de vie par minute tant que l'appli est ouverte et visible (voir presence_ping dans schema.sql).
import { supabase } from './supabase';
import { state } from './store';

const BEAT_MS = 60_000;                       // un signe de vie par minute
let timer: number | undefined;
let names: string[] = [];                     // personnes en ligne (dernière réponse du serveur)

/** Noms des personnes en ligne ; liste vide tant que le serveur n'a pas répondu ou hors ligne. */
export const onlineNames = (): string[] => (navigator.onLine ? names : []);

/** Envoie le signe de vie puis relit qui est en ligne ; n'échoue jamais bruyamment. */
async function beat(): Promise<void> {
  if (!navigator.onLine || !state.session || document.visibilityState !== 'visible') return;
  try {
    await supabase.rpc('presence_ping');
    const { data, error } = await supabase.rpc('online_users');
    if (error) return;   // SQL pas encore rejoué : la pastille reste simplement cachée
    names = ((data ?? []) as { label: string }[]).map((r) => r.label);
    window.dispatchEvent(new Event('presence-changed'));
  } catch { /* réseau instable : on réessaie à la prochaine minute */ }
}

/** Démarre la surveillance (une seule fois) : au premier plan toutes les minutes, tout de suite au retour. */
export function startPresence(): void {
  if (timer !== undefined) return;
  const run = () => { void beat(); if (timer === undefined) timer = window.setInterval(() => void beat(), BEAT_MS); };
  const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? run() : stop()));
  window.addEventListener('online', run);
  run();
}

/** À la déconnexion volontaire : le départ est écrit tout de suite au journal. */
export async function leavePresence(): Promise<void> {
  try { await supabase.rpc('presence_leave'); } catch { /* ignore */ }
  names = [];
}
