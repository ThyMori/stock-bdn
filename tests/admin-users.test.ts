import assert from 'node:assert/strict';
import { handle } from '../supabase/functions/admin-users/index';

// Faux client Supabase : enregistre les appels et rejoue des réponses prévues.
function fake(opts: { callerRole?: string; callerActive?: boolean; inviteError?: string; updateError?: string; confirmed?: boolean; rows?: number } = {}) {
  const calls: [string, unknown][] = [];
  const db = {
    auth: {
      getUser: async (t: string) => (t === 'bad' ? { data: { user: null }, error: { message: 'x' } } : { data: { user: { id: 'ME' } }, error: null }),
      admin: {
        inviteUserByEmail: async (e: string, o: unknown) => { calls.push(['invite', [e, o]]); return opts.inviteError ? { data: null, error: { message: opts.inviteError } } : { data: { user: { id: 'NEW' } }, error: null }; },
        updateUserById: async (id: string, a: unknown) => { calls.push(['ban', [id, a]]); return { error: null }; },
        getUserById: async (id: string) => ({ data: { user: { id, email: 'p@x.fr', email_confirmed_at: opts.confirmed ? '2026-01-01' : null } }, error: null }),
        listUsers: async () => ({ data: { users: [{ id: 'A', email_confirmed_at: '2026-01-01', last_sign_in_at: '2026-11-01' }, { id: 'B' }] }, error: null })
      }
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let mode = 'select', patch: unknown;
      const chain = {
        select: () => chain, order: () => Promise.resolve({ data: [{ id: 'A', email: 'a@x', role: 'admin', active: true }, { id: 'B', email: 'b@x', role: 'lecteur', active: true }], error: null }),
        update: (p: unknown) => { mode = 'update'; patch = p; return chain; },
        eq: (_c: string, v: string) => { q.id = v; return chain; },
        maybeSingle: async () => ({ data: { role: opts.callerRole ?? 'admin', active: opts.callerActive ?? true } }),
        then: (res: (v: unknown) => void) => {
          if (mode === 'update') { calls.push(['update:' + table, [q.id, patch]]); res(opts.updateError ? { data: null, error: { message: opts.updateError } } : { data: Array.from({ length: opts.rows ?? 1 }, () => ({ id: q.id })), error: null }); }
          else res({ data: null, error: null });
        }
      };
      return chain;
    }
  };
  return { calls, create: () => db };
}
const call = (body: unknown, f: ReturnType<typeof fake>, token = 'ok', method = 'POST') =>
  handle(new Request('http://x/', { method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: method === 'POST' ? JSON.stringify(body) : undefined }), { url: 'u', service: 's' }, f.create);
const out = async (r: Response) => ({ status: r.status, ...(await r.json()) as object }) as { status: number; error?: string; ok?: boolean; users?: any[] };

let n = 0; const t = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log('ok -', name); };

await t('sans jeton ou jeton invalide : 401', async () => {
  assert.equal((await out(await call({ action: 'list' }, fake(), ''))).status, 401);
  assert.equal((await out(await call({ action: 'list' }, fake(), 'bad'))).status, 401);
});
await t('non-admin ou admin révoqué : 403, aucune action effectuée', async () => {
  for (const o of [{ callerRole: 'technicien' }, { callerRole: 'lecteur' }, { callerRole: 'admin', callerActive: false }]) {
    const f = fake(o); const r = await out(await call({ action: 'invite', email: 'a@b.fr', role: 'admin' }, f));
    assert.equal(r.status, 403); assert.equal(f.calls.length, 0);
  }
});
await t('invitation : e-mail envoyé puis rôle appliqué', async () => {
  const f = fake(); const r = await out(await call({ action: 'invite', email: ' Nouveau@BdN.fr ', role: 'technicien', redirect_to: 'https://app/' }, f));
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls[0], ['invite', ['nouveau@bdn.fr', { redirectTo: 'https://app/' }]]);
  assert.deepEqual(f.calls[1], ['update:profiles', ['NEW', { role: 'technicien' }]]);
});
await t('invitation : e-mail invalide, rôle invalide, compte existant', async () => {
  assert.equal((await out(await call({ action: 'invite', email: 'pas-un-mail', role: 'lecteur' }, fake()))).status, 400);
  assert.equal((await out(await call({ action: 'invite', email: 'a@b.fr', role: 'root' }, fake()))).status, 400);
  const r = await out(await call({ action: 'invite', email: 'a@b.fr', role: 'lecteur' }, fake({ inviteError: 'User already registered' })));
  assert.equal(r.status, 409);
});
await t('révocation : droits coupés dans la base PUIS connexion bloquée', async () => {
  const f = fake(); const r = await out(await call({ action: 'set_access', id: 'B', active: false }, f));
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls, [['update:profiles', ['B', { active: false }]], ['ban', ['B', { ban_duration: '876000h' }]]]);
});
await t('rétablissement : accès rendu et blocage levé', async () => {
  const f = fake(); await call({ action: 'set_access', id: 'B', active: true }, f);
  assert.deepEqual(f.calls[1], ['ban', ['B', { ban_duration: 'none' }]]);
});
await t('on ne peut pas révoquer son propre accès', async () => {
  const f = fake(); const r = await out(await call({ action: 'set_access', id: 'ME', active: false }, f));
  assert.equal(r.status, 400); assert.equal(f.calls.length, 0);
});
await t('dernier administrateur : l\'erreur de la base est renvoyée, pas de blocage de connexion', async () => {
  const f = fake({ updateError: 'Impossible : il doit rester au moins un administrateur actif' });
  const r = await out(await call({ action: 'set_access', id: 'B', active: false }, f));
  assert.equal(r.status, 400); assert.match(r.error!, /au moins un administrateur/);
  assert.ok(!f.calls.some(([k]) => k === 'ban'));
});
await t('compte inconnu : 404', async () => {
  assert.equal((await out(await call({ action: 'set_access', id: 'ZZ', active: false }, fake({ rows: 0 })))).status, 404);
});
await t('renvoyer : seulement si le compte n\'est pas encore activé', async () => {
  const ok = fake(); assert.equal((await out(await call({ action: 'resend', id: 'P' }, ok))).status, 200);
  assert.equal(ok.calls[0][0], 'invite');
  assert.equal((await out(await call({ action: 'resend', id: 'P' }, fake({ confirmed: true })))).status, 400);
});
await t('liste : profils + statut d\'activation + dernière connexion', async () => {
  const r = await out(await call({ action: 'list' }, fake()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.users!.map((u) => [u.id, u.confirmed, u.last_sign_in_at]), [['A', true, '2026-11-01'], ['B', false, null]]);
});
await t('GET refusé, action inconnue : 400', async () => {
  assert.equal((await out(await call(null, fake(), 'ok', 'GET'))).status, 405);
  assert.equal((await out(await call({ action: 'drop' }, fake()))).status, 400);
});
console.log(`\n${n} tests OK`);
