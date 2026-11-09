// Notifications push (Web Push) : abonnement de cet appareil, essai, et déclenchement à la publication d'un message.
// La clé publique VAPID peut être publique ; la clé privée n'existe que dans la fonction serveur « push-notify ».
import { supabase } from './supabase';
import { can } from './store';

export const VAPID_PUBLIC_KEY = 'BCD_wF5cDyfY5fKoV9Jg3zWFyEy9hQ-ddz6HEcyIgXHtdl66LixKLBWfhS5fN1BgZ79B1YX4s1tpx-CgtzMScBE';

export type PushStatus = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

const flag = (uid: string) => `push:${uid}`;
const getFlag = (uid: string): boolean => { try { return localStorage.getItem(flag(uid)) === '1'; } catch { return false; } };
const setFlag = (uid: string, on: boolean) => { try { if (on) localStorage.setItem(flag(uid), '1'); else localStorage.removeItem(flag(uid)); } catch { /* stockage indisponible */ } };

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

function keyBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 6000))]);
}

export async function pushStatus(uid: string): Promise<PushStatus> {
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted' || !getFlag(uid)) return 'off';
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

async function saveSub(sub: PushSubscription): Promise<string | null> {
  const j = sub.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', { p_endpoint: sub.endpoint, p_p256dh: j.keys?.p256dh ?? '', p_auth: j.keys?.auth ?? '', p_ua: navigator.userAgent });
  return error ? error.message : null;
}

/** Active les notifications sur cet appareil. Renvoie un message d'erreur, ou null. */
export async function enablePush(uid: string): Promise<string | null> {
  if (!navigator.onLine) return 'Cette action demande une connexion.';
  const perm = await Notification.requestPermission();   // doit rester le premier await : il faut un geste de l'utilisateur
  if (perm !== 'granted') return perm === 'denied' ? 'Notifications refusées : autorise-les dans les réglages du navigateur ou du téléphone.' : 'Autorisation non accordée.';
  const reg = await registration();
  if (!reg) return 'Le service worker n’est pas prêt (rouvre l’appli installée, ou recharge la page).';
  try {
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) as BufferSource }));
    const err = await saveSub(sub);
    if (err) return /push_subscriptions|save_push_subscription|schema cache/i.test(err) ? 'La base n’est pas à jour : rejoue supabase/schema.sql (voir le README).' : err;
    setFlag(uid, true);
    return null;
  } catch (e) { return 'Abonnement impossible : ' + (e as Error).message; }
}

/** Désactive les notifications sur cet appareil. */
export async function disablePush(uid: string): Promise<string | null> {
  setFlag(uid, false);
  try {
    const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (sub) { await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
  } catch (e) { return (e as Error).message; }
  return null;
}

/** À l'ouverture de l'appli : ré-enregistre l'abonnement (changement de compte sur l'appareil, abonnement renouvelé par le navigateur). */
export async function syncPush(uid: string): Promise<void> {
  try {
    if (!getFlag(uid) || !('PushManager' in window) || Notification.permission !== 'granted' || !navigator.onLine) return;
    const reg = await registration(); if (!reg) return;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) as BufferSource }));
    await saveSub(sub);
  } catch { /* au mieux */ }
}

/** À la déconnexion : l'appareil ne reçoit plus les messages de ce compte (réactivé à la prochaine connexion du même compte). */
export async function forgetPushOnLogout(): Promise<void> {
  try {
    if (!navigator.onLine || !('serviceWorker' in navigator)) return;
    const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
    if (sub) await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
  } catch { /* au mieux */ }
}

async function callPush(body: Record<string, unknown>): Promise<{ error: string | null; data: Record<string, unknown> | null }> {
  const { data, error } = await supabase.functions.invoke('push-notify', { body });
  if (error) {
    const res = (error as { context?: Response }).context;
    let msg = error.message;
    try {
      const j = await res?.json();
      if (j?.error) msg = j.error;                                             // message de la fonction elle-même
      else if (res?.status === 404) msg = 'La fonction « push-notify » n’est pas déployée sur Supabase (voir le README).';
    } catch { if (res?.status === 404) msg = 'La fonction « push-notify » n’est pas déployée sur Supabase (voir le README).'; }
    return { error: msg, data: null };
  }
  return { error: null, data: data as Record<string, unknown> };
}

/** Envoie une notification d'essai à mes appareils. */
export async function testPush(): Promise<string> {
  if (!navigator.onLine) return 'Cette action demande une connexion.';
  const r = await callPush({ action: 'test' });
  if (r.error) return r.error;
  const d = r.data ?? {};
  return Number(d.sent) > 0 ? `Notification envoyée (${d.sent} appareil${Number(d.sent) > 1 ? 's' : ''}).` : 'Envoi échoué : l’appareil n’a pas accepté la notification.';
}

/** Choix « @all » du sélecteur de citation : réservé aux régisseurs généraux et aux administrateurs (le serveur le vérifie aussi). */
export const ALL_OPT = (): [string, string][] => (can('regisseur_general') ? [['@all', '@all · tout le monde (notifie tous les comptes)']] : []);

/** Après la publication d'un message : prévient les personnes concernées (sans bloquer ni signaler d'erreur à l'auteur). */
export function notifyPost(postId: string): void {
  if (!navigator.onLine) return;
  void callPush({ action: 'post', post_id: postId }).catch(() => { /* la publication a réussi : les notifications sont un bonus */ });
}

/** Clic sur une notification alors que l'appli est ouverte : le service worker demande de changer de page. */
export function listenPushNavigation(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const h = (e.data as { nav?: unknown } | null)?.nav;
    if (typeof h === 'string' && h.startsWith('#/')) location.hash = h;
  });
}
