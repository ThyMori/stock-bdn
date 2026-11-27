// Edge Function « push-notify » : envoie les notifications push (Web Push) du mur.
//
//   { action: "post", post_id }   -> prévient les personnes concernées par un message du mur (appelé par l'appli juste après la publication)
//   { action: "removals" }       -> prévient les personnes concernées des projecteurs retirés d'un spectacle à venir (panne / SAV) ; chaque retrait n'est notifié qu'une fois
//   { action: "test" }            -> envoie une notification d'essai aux appareils de l'appelant
//   { action: "signup", first_name, last_name, email, message }
//                                 -> PUBLIC (sans connexion) : enregistre une demande d'inscription et prévient les administrateurs
//
// Qui est prévenu est décidé en base (fonction SQL push_targets) :
//   message d'un spectacle        -> tous les régisseurs généraux et administrateurs, les personnes concernées (régisseurs assignés, créateur, personnes déjà intervenues sur son mur) et les personnes citées ;
//   annonce admin / info générale -> silencieuses, sauf pour les personnes citées.
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

export interface Target { user_id: string; endpoint: string; p256dh: string; auth_key: string; mentioned: boolean; everyone: boolean; kind: string; show_id: string | null; show_name: string | null; author_label: string | null; body: string }
export interface RemovalTarget { user_id: string; endpoint: string; p256dh: string; auth_key: string; show_id: string; show_name: string | null; item_id: number; model_name: string | null; reason: string; kept: boolean; was_complete: boolean }
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
    title: t.mentioned ? `${who} t’a cité · ${show}` : t.everyone ? `${who} à tous · ${show}` : show,
    body: t.mentioned || t.everyone ? text : `${who} : ${text}`,
    url: t.show_id ? `#/show/${t.show_id}` : '#/mur',
    tag
  };
}

/** Notification d'un projecteur retiré (ou gardé car déjà patché) d'un spectacle à venir. */
export function buildRemovalPayload(t: RemovalTarget, removalId: string): Payload {
  const model = t.model_name || 'projecteur', show = t.show_name || 'Spectacle';
  const body = t.kept
    ? `N° ${t.item_id} (${model}) : ${t.reason}. Déjà patché, il reste dans le spectacle : à toi de décider.`
    : `N° ${t.item_id} (${model}) retiré : ${t.reason}. Il manque 1 × ${model} à affecter.`;
  return { title: `${t.was_complete ? '⚠ Spectacle complet · ' : '⚠ '}${show}`, body, url: `#/show/${t.show_id}`, tag: 'removal-' + removalId };
}

/** Demande d'inscription : enregistrement en base, puis notification push à tous les administrateurs actifs (au mieux). */
async function signup(body: Record<string, unknown>, admin: Client, env: Env, send: Sender): Promise<Response> {
  const OK = json(200, { ok: true });
  if (typeof body.website === 'string' && body.website.trim() !== '') return OK;   // robot : on fait semblant
  const t = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const first = t(body.first_name, 60), last = t(body.last_name, 60), email = t(body.email, 120), message = t(body.message, 500);
  if (!first || !last) return json(400, { error: 'Prénom et nom obligatoires' });
  const { data, error } = await admin.rpc('create_signup_request', { p_first: first, p_last: last, p_email: email, p_message: message });
  if (error) {
    const m = String(error.message);
    const known = /invalide|obligatoires|Trop de demandes/.test(m);
    return json(known ? (/Trop/.test(m) ? 429 : 400) : 500, { error: known ? m : 'Envoi impossible pour le moment' });
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.is_new || !env.vapidPublic || !env.vapidPrivate) return OK;   // doublon / compte existant, ou push non configuré : rien à notifier
  const { data: admins } = await admin.from('profiles').select('id').eq('role', 'admin').eq('active', true);
  const ids = (admins ?? []).map((a: Client) => a.id);
  if (!ids.length) return OK;
  const { data: subs } = await admin.from('push_subscriptions').select('endpoint,p256dh,auth_key').in('user_id', ids);
  const payload: Payload = { title: 'Demande d’inscription', body: `${first} ${last} (${email}) souhaite accéder à l’application`, url: '#/admin/users', tag: 'signup-' + row.id };
  const dead: string[] = [];
  await Promise.all((subs ?? []).map(async (x: Client) => {
    try { await send({ endpoint: x.endpoint, keys: { p256dh: x.p256dh, auth: x.auth_key } }, JSON.stringify(payload)); }
    catch (e) { const c = (e as { statusCode?: number })?.statusCode; if (c === 404 || c === 410) dead.push(x.endpoint); }
  }));
  if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);
  return OK;   // la personne reçoit toujours la même réponse, quoi qu'il arrive côté notification
}

export async function handle(req: Request, env: Env, createClient: (url: string, key: string, opts?: unknown) => Client, send: Sender): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Méthode non autorisée' });

  const admin = createClient(env.url, env.service, { auth: { persistSession: false, autoRefreshToken: false } });

  // Seule action ouverte sans connexion : la demande d'inscription (la personne n'a pas encore de compte).
  // Garde-fous : piège à robots (champ « website » rempli = on ignore), validation et limite horaire dans create_signup_request.
  const raw = await req.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (raw && raw.action === 'signup') return signup(raw, admin, env, send);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Non connecté' });

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

  if (body.action === 'removals') {
    // réservation atomique de tous les retraits récents pas encore notifiés (n'importe quel utilisateur actif peut déclencher, rien d'autre que l'envoi)
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data: claimed } = await admin.from('show_removals').update({ push_sent_at: new Date().toISOString() }).is('push_sent_at', null).gte('created_at', since).select('id');
    let devices = 0, sent = 0, failed = 0;
    for (const c of (claimed ?? []) as { id: string }[]) {
      const { data: targets, error } = await admin.rpc('push_targets_removal', { p_removal: c.id });
      if (error) return json(500, { error: error.message });
      devices += (targets ?? []).length;
      const r = await deliver((targets ?? []).map((t: RemovalTarget) => ({ sub: { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth_key } }, payload: buildRemovalPayload(t, c.id) })));
      sent += r.sent; failed += r.failed;
    }
    return json(200, { ok: true, removals: (claimed ?? []).length, devices, sent, failed });
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
