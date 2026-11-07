// Edge Function « admin-users » : gestion des comptes, réservée aux régisseurs généraux et aux administrateurs.
//
//   { action: "list" }                                  -> liste des comptes (avec statut) + rôle de l'appelant
//   { action: "invite",  email, role, redirect_to }     -> envoie un e-mail d'invitation
//   { action: "resend",  id, redirect_to }              -> renvoie l'invitation (compte pas encore activé)
//   { action: "set_role", id, role }                    -> change le rôle d'un compte
//   { action: "set_access", id, active: true|false }    -> révoque / rétablit l'accès (le compte n'est jamais supprimé)
//
// Hiérarchie : technicien < régisseur < régisseur général < administrateur.
//   - l'administrateur gère tout le monde ;
//   - le régisseur général ne peut gérer que des comptes de rang inférieur au sien (technicien, régisseur)
//     et ne peut leur attribuer que ces rôles : il ne peut donc ni créer ni modifier un autre régisseur général ou un admin ;
//   - personne ne modifie son propre compte.
//
// La clé « service_role » n'existe que dans cette fonction (variable d'environnement fournie par Supabase) :
// elle n'est jamais envoyée au navigateur. L'identité de l'appelant est vérifiée ici, à chaque appel.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const RANK: Record<string, number> = { technicien: 1, regisseur: 2, regisseur_general: 3, admin: 4 };
const ROLES = Object.keys(RANK);
/** Peut-on gérer un compte de ce rôle / attribuer ce rôle ? (l'admin : tout ; sinon uniquement en dessous de soi) */
const canTouch = (callerRole: string, role: string) => callerRole === 'admin' || (RANK[role] ?? 99) < RANK[callerRole];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BAN_FOREVER = '876000h'; // ~100 ans : le compte ne peut plus se connecter

// deno-lint-ignore no-explicit-any
type Client = any;
export interface Env { url: string; service: string }

export async function handle(req: Request, env: Env, createClient: (url: string, key: string, opts?: unknown) => Client): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Méthode non autorisée' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Non connecté' });

  const admin = createClient(env.url, env.service, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) qui appelle ?
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  const caller = who?.user;
  if (whoErr || !caller) return json(401, { error: 'Session invalide, reconnecte-toi' });

  // 2) est-il régisseur général ou administrateur, et actif ?
  const { data: me } = await admin.from('profiles').select('role,active').eq('id', caller.id).maybeSingle();
  if (!me || !me.active || (RANK[me.role] ?? 0) < RANK.regisseur_general) return json(403, { error: 'Réservé aux régisseurs généraux et aux administrateurs' });
  const myRole: string = me.role;
  const targetRole = async (id: string): Promise<string | null> => {
    const { data } = await admin.from('profiles').select('role').eq('id', id).maybeSingle();
    return data?.role ?? null;
  };

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'Requête invalide' }); }
  const redirectTo = typeof body.redirect_to === 'string' ? body.redirect_to : undefined;

  switch (body.action) {
    case 'list': {
      const { data: profiles, error } = await admin.from('profiles').select('id,email,role,active').order('email');
      if (error) return json(500, { error: error.message });
      const { data: au, error: e2 } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (e2) return json(500, { error: e2.message });
      const byId = new Map((au?.users ?? []).map((u: Client) => [u.id, u]));
      const users = (profiles ?? []).map((p: Client) => {
        const u = byId.get(p.id) as Client;
        return { ...p, confirmed: !!(u?.email_confirmed_at ?? u?.confirmed_at), last_sign_in_at: u?.last_sign_in_at ?? null };
      });
      return json(200, { users, caller_role: myRole });
    }

    case 'invite': {
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = String(body.role ?? 'technicien');
      if (!EMAIL.test(email)) return json(400, { error: 'Adresse e-mail invalide' });
      if (!ROLES.includes(role)) return json(400, { error: 'Rôle invalide' });
      if (!canTouch(myRole, role)) return json(403, { error: 'Tu ne peux pas attribuer ce rôle.' });
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (error) {
        const taken = /already|registered|exists/i.test(error.message);
        return json(taken ? 409 : 400, { error: taken ? 'Cette adresse a déjà un compte.' : error.message });
      }
      // le profil est créé par un déclencheur (rôle « technicien ») : on applique le rôle choisi
      const { error: e2 } = await admin.from('profiles').update({ role }).eq('id', data.user.id);
      if (e2) return json(500, { error: 'Invitation envoyée mais rôle non appliqué : ' + e2.message });
      return json(200, { ok: true, id: data.user.id });
    }

    case 'resend': {
      const id = String(body.id ?? '');
      const tr = await targetRole(id);
      if (tr && !canTouch(myRole, tr)) return json(403, { error: 'Tu ne peux pas gérer ce compte.' });
      const { data, error } = await admin.auth.admin.getUserById(id);
      const u = data?.user;
      if (error || !u?.email) return json(404, { error: 'Compte introuvable' });
      if (u.email_confirmed_at ?? u.confirmed_at) return json(400, { error: 'Ce compte est déjà activé : utilise « Mot de passe oublié » sur l\'écran de connexion.' });
      const { error: e2 } = await admin.auth.admin.inviteUserByEmail(u.email, { redirectTo });
      if (e2) return json(400, { error: e2.message });
      return json(200, { ok: true });
    }

    case 'set_role': {
      const id = String(body.id ?? ''); const role = String(body.role ?? '');
      if (!ROLES.includes(role)) return json(400, { error: 'Rôle invalide' });
      if (id === caller.id) return json(400, { error: 'Tu ne peux pas modifier ton propre rôle.' });
      const tr = await targetRole(id);
      if (!tr) return json(404, { error: 'Compte introuvable' });
      if (!canTouch(myRole, tr) || !canTouch(myRole, role)) return json(403, { error: 'Tu ne peux pas attribuer ce rôle à ce compte.' });
      const { data: upd, error } = await admin.from('profiles').update({ role }).eq('id', id).select('id');
      if (error) return json(400, { error: error.message });
      if (!upd?.length) return json(404, { error: 'Compte introuvable' });
      return json(200, { ok: true });
    }

    case 'set_access': {
      const id = String(body.id ?? '');
      if (typeof body.active !== 'boolean') return json(400, { error: 'Paramètre « active » manquant' });
      if (id === caller.id) return json(400, { error: 'Tu ne peux pas modifier ton propre accès.' });
      const tr = await targetRole(id);
      if (tr && !canTouch(myRole, tr)) return json(403, { error: 'Tu ne peux pas gérer ce compte.' });
      // 1) coupure immédiate des droits dans la base (même si la personne a une session ouverte)
      const { data: upd, error } = await admin.from('profiles').update({ active: body.active }).eq('id', id).select('id');
      if (error) return json(400, { error: error.message });
      if (!upd?.length) return json(404, { error: 'Compte introuvable' });
      // 2) interdiction (ou autorisation) de se reconnecter
      const { error: e2 } = await admin.auth.admin.updateUserById(id, { ban_duration: body.active ? 'none' : BAN_FOREVER });
      if (e2) return json(500, { error: 'Droits modifiés, mais le blocage de connexion a échoué : ' + e2.message });
      return json(200, { ok: true });
    }

    default:
      return json(400, { error: 'Action inconnue' });
  }
}

// Démarrage sous Deno (Supabase). Ignoré quand le fichier est importé par les tests.
// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D) {
  // @ts-ignore : spécificateur résolu par Deno uniquement
  const { createClient } = await import('npm:@supabase/supabase-js@2');
  D.serve((req: Request) =>
    handle(req, { url: D.env.get('SUPABASE_URL')!, service: D.env.get('SUPABASE_SERVICE_ROLE_KEY')! }, createClient));
}
