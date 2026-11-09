// Edge Function « push-notify » : envoie les notifications push (Web Push) du mur.
//
//   { action: "post", post_id }   -> prévient les personnes concernées par un message du mur (appelé par l'appli juste après la publication)
//   { action: "test" }            -> envoie une notification d'essai aux appareils de l'appelant
//
// Qui est prévenu est décidé en base (fonction SQL push_targets) : uniquement les personnes citées (@Nom).
// « @all » prévient tous les comptes, mais seulement s'il est écrit par un régisseur général ou un administrateur.
//
// Sécurité : l'identité de l'appelant est vérifiée ici (jeton de connexion). Pour « post », seul l'auteur du message peut déclencher
// l'envoi, et chaque message n'est notifié qu'une seule fois (colonne show_posts.push_sent_at). La clé « service_role » et la clé
// privée VAPID n'existent que dans cette fonction (secrets Supabase) : jamais dans l'appli.
//
// Secrets à créer : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (et, facultatif, VAPID_SUBJECT).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Client = any;
export interface Env { url: string; service: string; vapidPublic?: string; vapidPrivate?: string; subject?: string }
export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
/** Envoie un message à un appareil ; lève une erreur portant `statusCode` en cas d'échec (404 / 410 = abonnement mort). */
export type Sender = (sub: PushSub, payload: string) => Promise<unknown>;

export interface Target { user_id: string; endpoint: string; p256dh: string; auth_key: string; everyone: boolean; kind: string; show_id: string | null; show_name: string | null; author_label: string | null; body: string }
export interface Payload { title: string; body: string; url: string; tag: string }

/** Texte lisible d'un message : les citations « @[Nom](u:uuid) » deviennent « @Nom », espaces compactés, tronqué. */
export function plainText(body: string, max = 140): string {
  const t = body.replace(/@\[([^\]]+)\]\(u:[0-9a-f-]{36}\)/g, '@$1').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Contenu de la notification pour un destinataire. `url` est relatif à l'appli (« #/mur », « #/show/… »). */
export function buildPayload(t: Target, postId: string): Payload {
  const who = t.author_label || 'Quelqu’un';
  const text = plainText(t.body);
  const tag = 'post-' + postId;
  if (t.kind === 'admin') return { title: `Annonce admin · ${who}`, body: text, url: '#/mur', tag };
  if (t.kind === 'general') return { title: `Info générale · ${who}`, body: text, url: '#/mur', tag };
  const show = t.show_name || 'Spectacle';
  return {
    title: t.everyone ? `${who} à tous · ${show}` : `${who} t’a cité · ${show}`,
    body: text,
    url: t.show_id ? `#/show/${t.show_id}` : '#/mur',
    tag
  };
}

export async function handle(req: Request, env: Env, createClient: (url: string, key: string, opts?: unknown) => Client, send: Sender): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Méthode non autorisée' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Non connecté' });
  const admin = createClient(env.url, env.service, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  const caller = who?.user;
  if (whoErr || !caller) return json(401, { error: 'Session invalide, reconnecte-toi' });
  const { data: me } = await admin.from('profiles').select('role,active').eq('id', caller.id).maybeSingle();
  if (!me || !me.active) return json(403, { error: 'Accès refusé' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'Requête invalide' }); }

  if (!env.vapidPublic || !env.vapidPrivate) {
    return json(500, { error: 'Clés VAPID absentes : crée les secrets VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY de la fonction push-notify' });
  }

  // Envoi à une liste d'appareils ; les abonnements morts (404 / 410) sont supprimés.
  const deliver = async (items: { sub: PushSub; payload: Payload }[]) => {
    let sent = 0, failed = 0; const dead: string[] = [];
    await Promise.all(items.map(async ({ sub, payload }) => {
      try { await send(sub, JSON.stringify(payload)); sent++; }
      catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) dead.push(sub.endpoint); else failed++;
      }
    }));
    if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);
    return { sent, failed, removed: dead.length };
  };

  if (body.action === 'test') {
    const { data: subs } = await admin.from('push_subscriptions').select('endpoint,p256dh,auth_key').eq('user_id', caller.id);
    if (!subs?.length) return json(404, { error: 'Aucun appareil abonné : active d’abord les notifications' });
    const payload: Payload = { title: 'Stock BdN', body: 'Les notifications fonctionnent ✓', url: '#/more', tag: 'test' };
    const r = await deliver(subs.map((s: Client) => ({ sub: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload })));
    return json(200, { ok: true, devices: subs.length, ...r });
  }

  if (body.action === 'post') {
    const id = typeof body.post_id === 'string' ? body.post_id : '';
    if (!/^[0-9a-f-]{36}$/.test(id)) return json(400, { error: 'Message inconnu' });
    const { data: post } = await admin.from('show_posts').select('id,author_id').eq('id', id).maybeSingle();
    if (!post) return json(404, { error: 'Message introuvable' });
    if (post.author_id !== caller.id) return json(403, { error: 'Seul l’auteur du message peut déclencher les notifications' });
    // « réservation » atomique : un message n'est notifié qu'une fois, même si l'appli insiste
    const { data: claimed } = await admin.from('show_posts').update({ push_sent_at: new Date().toISOString() }).eq('id', id).is('push_sent_at', null).select('id');
    if (!claimed?.length) return json(200, { ok: true, sent: 0, already: true });
    const { data: targets, error } = await admin.rpc('push_targets', { p_post: id });
    if (error) return json(500, { error: error.message });
    const r = await deliver((targets ?? []).map((t: Target) => ({
      sub: { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth_key } },
      payload: buildPayload(t, id)
    })));
    return json(200, { ok: true, devices: (targets ?? []).length, ...r });
  }

  return json(400, { error: 'Action inconnue' });
}

// Démarrage sous Deno (Supabase). Ignoré quand le fichier est importé par les tests.
// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D) {
  // @ts-ignore : spécificateur résolu par Deno uniquement
  const { createClient } = await import('npm:@supabase/supabase-js@2');
  // @ts-ignore : idem
  const webpush = (await import('npm:web-push@3.6.7')).default;
  const pub = D.env.get('VAPID_PUBLIC_KEY'), priv = D.env.get('VAPID_PRIVATE_KEY');
  if (pub && priv) webpush.setVapidDetails(D.env.get('VAPID_SUBJECT') || 'https://stock-bdn.thierry-morin.com/', pub, priv);
  const send: Sender = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 86400 });
  D.serve((req: Request) =>
    handle(req, { url: D.env.get('SUPABASE_URL')!, service: D.env.get('SUPABASE_SERVICE_ROLE_KEY')!, vapidPublic: pub, vapidPrivate: priv }, createClient, send));
}
