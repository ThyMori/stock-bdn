import assert from 'node:assert/strict';
import { buildPayload, buildRemovalPayload, handle, plainText, type RemovalTarget, type Target } from '../supabase/functions/push-notify/index';

const T = (o: Partial<Target> = {}): Target => ({ user_id: 'U', endpoint: 'https://p/1', p256dh: 'k', auth_key: 'a', mentioned: false, everyone: false, kind: 'show', show_id: 'S1', show_name: 'Pasolini', author_label: 'Marie D', body: 'Bonjour', ...o });

// ---- contenu des notifications ----
assert.equal(plainText('Merci @[Jean Dupont](u:aaaaaaaa-0000-0000-0000-000000000001)   pour\nle prêt'), 'Merci @Jean Dupont pour le prêt');
assert.ok(plainText('x'.repeat(300)).length <= 140 && plainText('x'.repeat(300)).endsWith('…'));
assert.deepEqual(buildPayload(T(), 'P'), { title: 'Pasolini', body: 'Marie D : Bonjour', url: '#/show/S1', tag: 'post-P' });
assert.equal(buildPayload(T({ mentioned: true }), 'P').title, 'Marie D t’a cité · Pasolini');
assert.equal(buildPayload(T({ everyone: true }), 'P').title, 'Marie D à tous · Pasolini');
assert.equal(buildPayload(T({ kind: 'admin', show_id: null, show_name: null }), 'P').title, 'Annonce admin · Marie D');
assert.equal(buildPayload(T({ kind: 'general', show_id: null, show_name: null }), 'P').url, '#/mur');

// ---- fonction ----
function fake(o: { callerActive?: boolean; author?: string; claimed?: boolean; targets?: Target[]; subs?: unknown[]; rpcError?: string } = {}) {
  const calls: [string, unknown][] = [];
  const db = {
    auth: { getUser: async (t: string) => (t === 'bad' ? { data: { user: null }, error: { message: 'x' } } : { data: { user: { id: 'ME' } }, error: null }) },
    rpc: async (fn: string, a: unknown) => { calls.push(['rpc:' + fn, a]); return o.rpcError ? { data: null, error: { message: o.rpcError } } : { data: o.targets ?? [], error: null }; },
    from: (table: string) => {
      let mode = 'select';
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, is: () => chain, gte: () => chain,
        update: (p: unknown) => { mode = 'update'; calls.push(['update:' + table, p]); return chain; },
        delete: () => { mode = 'delete'; return chain; },
        in: (_c: string, v: unknown) => { calls.push(['delete:' + table, v]); return Promise.resolve({ error: null }); },
        maybeSingle: async () => {
          if (table === 'profiles') return { data: { role: 'technicien', active: o.callerActive ?? true } };
          if (table === 'show_posts') return { data: o.author === 'none' ? null : { id: 'p', author_id: o.author ?? 'ME' } };
          return { data: null };
        },
        then: (res: (v: unknown) => void) => {
          if (table === 'show_removals' && mode === 'update') res({ data: o.claimed === false ? [] : [{ id: 'r1' }, { id: 'r2' }], error: null });
          else if (table === 'show_posts' && mode === 'update') res({ data: o.claimed === false ? [] : [{ id: 'p' }], error: null });
          else if (table === 'push_subscriptions') res({ data: o.subs ?? [], error: null });
          else res({ data: null, error: null });
        }
      };
      return chain;
    }
  };
  return { db, calls };
}
const env = { url: 'u', service: 's', vapidPublic: 'pub', vapidPrivate: 'priv' };
const POST_ID = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const req = (body: unknown, token = 'good') => new Request('https://f', { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: JSON.stringify(body) });
const run = async (f: ReturnType<typeof fake>, body: unknown, opts: { token?: string; e?: typeof env; fail?: Record<string, number> } = {}) => {
  const sent: { endpoint: string; payload: { title: string } }[] = [];
  const send = async (sub: { endpoint: string }, payload: string) => {
    if (opts.fail?.[sub.endpoint]) throw Object.assign(new Error('x'), { statusCode: opts.fail[sub.endpoint] });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  };
  const res = await handle(req(body, opts.token), opts.e ?? env, () => f.db, send);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, sent };
};

{ const r = await run(fake(), { action: 'post', post_id: POST_ID }, { token: '' }); assert.equal(r.status, 401); }
{ const r = await run(fake(), { action: 'post', post_id: POST_ID }, { token: 'bad' }); assert.equal(r.status, 401); }
{ const r = await run(fake({ callerActive: false }), { action: 'post', post_id: POST_ID }); assert.equal(r.status, 403, 'compte révoqué'); }
{ const r = await run(fake(), { action: 'post', post_id: POST_ID }, { e: { ...env, vapidPrivate: '' } }); assert.equal(r.status, 500); assert.match(String(r.body.error), /VAPID/); }
{ const r = await run(fake(), { action: 'post', post_id: 'nimporte quoi' }); assert.equal(r.status, 400); }
{ const f = fake({ author: 'none' }); const r = await run(f, { action: 'post', post_id: POST_ID }); assert.equal(r.status, 404); }
{ const f = fake({ author: 'AUTRE' }); const r = await run(f, { action: 'post', post_id: POST_ID }); assert.equal(r.status, 403, 'seul l\'auteur'); assert.ok(!f.calls.some((c) => c[0].startsWith('rpc:')));  }
{ // déjà notifié : rien n'est envoyé
  const f = fake({ claimed: false, targets: [T()] }); const r = await run(f, { action: 'post', post_id: POST_ID });
  assert.equal(r.status, 200); assert.equal(r.body.already, true); assert.equal(r.sent.length, 0); assert.ok(!f.calls.some((c) => c[0] === 'rpc:push_targets'));
}
{ // envoi nominal, une notification par appareil, citation personnalisée, abonnements morts supprimés
  const f = fake({ targets: [T({ endpoint: 'https://p/ok' }), T({ endpoint: 'https://p/cite', everyone: true }), T({ endpoint: 'https://p/mort' }), T({ endpoint: 'https://p/panne' })] });
  const r = await run(f, { action: 'post', post_id: POST_ID }, { fail: { 'https://p/mort': 410, 'https://p/panne': 500 } });
  assert.equal(r.status, 200); assert.deepEqual([r.body.devices, r.body.sent, r.body.failed, r.body.removed], [4, 2, 1, 1]);
  assert.equal(r.sent.find((x) => x.endpoint === 'https://p/cite')!.payload.title, 'Marie D à tous · Pasolini');
  assert.deepEqual(f.calls.find((c) => c[0] === 'delete:push_subscriptions')![1], ['https://p/mort']);
  assert.deepEqual(f.calls.find((c) => c[0] === 'rpc:push_targets')![1], { p_post: POST_ID });
}
{ const r = await run(fake({ rpcError: 'boom' }), { action: 'post', post_id: POST_ID }); assert.equal(r.status, 500); }
{ // essai : mes propres appareils
  const r = await run(fake({ subs: [{ endpoint: 'https://p/1', p256dh: 'k', auth_key: 'a' }, { endpoint: 'https://p/2', p256dh: 'k', auth_key: 'a' }] }), { action: 'test' });
  assert.equal(r.status, 200); assert.equal(r.sent.length, 2); assert.equal(r.sent[0].payload.title, 'Stock BdN');
}
{ const r = await run(fake({ subs: [] }), { action: 'test' }); assert.equal(r.status, 404); }
{ const r = await run(fake(), { action: 'nimporte' }); assert.equal(r.status, 400); }
console.log('push-notify : tout OK');

// ---- demande d'inscription (publique) ----
function fakeSignup(o: { rpc?: { data?: unknown; error?: { message: string } }; admins?: { id: string }[]; subs?: unknown[] } = {}) {
  const calls: [string, unknown][] = [];
  const db = {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'x' } }) },
    rpc: async (fn: string, a: unknown) => { calls.push(['rpc:' + fn, a]); return o.rpc ?? { data: [{ id: 'R1', is_new: true }], error: null }; },
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, delete: () => chain,
        in: (_c: string, v: unknown) => { calls.push(['in:' + table, v]); return chain; },
        then: (res: (v: unknown) => void) => res({ data: table === 'profiles' ? (o.admins ?? [{ id: 'A1' }]) : (o.subs ?? [{ endpoint: 'https://p/a', p256dh: 'k', auth_key: 'a' }]), error: null })
      };
      return chain;
    }
  };
  return { db, calls };
}
const sreq = (b: unknown) => new Request('https://f', { method: 'POST', body: JSON.stringify(b) });   // sans en-tête Authorization
const ssend = async (f: ReturnType<typeof fakeSignup>, b: unknown, e = env) => {
  const sent: { payload: { title: string; body: string; url: string } }[] = [];
  const res = await handle(sreq(b), e, () => f.db, async (_s, p) => { sent.push({ payload: JSON.parse(p) }); });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, sent };
};
const SU = { action: 'signup', first_name: ' Ana ', last_name: 'Lys', email: 'ana@test.fr', message: 'Salut' };
{ const f = fakeSignup(); const r = await ssend(f, SU);   // sans connexion : accepté, administrateurs prévenus
  assert.equal(r.status, 200); assert.equal(r.sent.length, 1); assert.equal(r.sent[0].payload.url, '#/admin/users'); assert.match(r.sent[0].payload.body, /Ana Lys \(ana@test\.fr\)/);
  assert.deepEqual(f.calls.find((c) => c[0] === 'rpc:create_signup_request')![1], { p_first: 'Ana', p_last: 'Lys', p_email: 'ana@test.fr', p_message: 'Salut' });
  assert.deepEqual(f.calls.find((c) => c[0] === 'in:push_subscriptions')![1], ['A1'], 'seulement les admins'); }
{ const f = fakeSignup(); const r = await ssend(f, { ...SU, website: 'http://spam' }); assert.equal(r.status, 200); assert.equal(r.sent.length, 0); assert.ok(!f.calls.length, 'robot : rien en base'); }
{ const r = await ssend(fakeSignup({ rpc: { data: [{ id: null, is_new: false }] } }), SU); assert.equal(r.status, 200); assert.equal(r.sent.length, 0, 'doublon : pas de notification'); }
{ const r = await ssend(fakeSignup({ rpc: { error: { message: 'Trop de demandes en ce moment, réessaie plus tard' } } }), SU); assert.equal(r.status, 429); }
{ const r = await ssend(fakeSignup({ rpc: { error: { message: 'Adresse e-mail invalide' } } }), SU); assert.equal(r.status, 400); }
{ const r = await ssend(fakeSignup({ rpc: { error: { message: 'secret interne SQL' } } }), SU); assert.equal(r.status, 500); assert.ok(!/secret/.test(String(r.body.error)), 'pas de fuite d\'erreur'); }
{ const r = await ssend(fakeSignup(), { ...SU, first_name: '' }); assert.equal(r.status, 400); }
{ const r = await ssend(fakeSignup(), SU, { ...env, vapidPrivate: '' }); assert.equal(r.status, 200, 'push non configuré : la demande est quand même enregistrée'); assert.equal(r.sent.length, 0); }
{ const r = await run(fake(), { action: 'post', post_id: POST_ID }, { token: '' }); assert.equal(r.status, 401, 'les autres actions restent protégées'); }
console.log('inscription : tout OK');

// ---- projecteur retiré d'un spectacle à venir ----
const RT = (o: Partial<RemovalTarget> = {}): RemovalTarget => ({ user_id: 'U', endpoint: 'https://p/1', p256dh: 'k', auth_key: 'a', show_id: 'S1', show_name: 'Pasolini', item_id: 12, model_name: 'PAR64', reason: 'en panne', kept: false, was_complete: true, ...o });
assert.deepEqual(buildRemovalPayload(RT(), 'R'), { title: '⚠ Spectacle complet · Pasolini', body: 'N° 12 (PAR64) retiré : en panne. Il manque 1 × PAR64 à affecter.', url: '#/show/S1', tag: 'removal-R' });
assert.equal(buildRemovalPayload(RT({ was_complete: false }), 'R').title, '⚠ Pasolini');
assert.match(buildRemovalPayload(RT({ kept: true }), 'R').body, /Déjà patché/);
{ const f = fake({ targets: [RT()] as unknown as Target[], subs: [] }); const r = await run(f, { action: 'removals' }); assert.equal(r.status, 200); assert.equal(r.body.removals, 2); assert.equal(r.sent.length, 2); assert.equal(r.sent[0].payload.title, '⚠ Spectacle complet · Pasolini');
  assert.equal(f.calls.filter((c) => c[0] === 'rpc:push_targets_removal').length, 2); }                                   // une cible calculée par retrait
{ const f = fake({ claimed: false }); const r = await run(f, { action: 'removals' }); assert.equal(r.body.removals, 0); assert.equal(f.calls.filter((c) => c[0] === 'rpc:push_targets_removal').length, 0); }   // déjà notifié : rien
{ const r = await run(fake(), { action: 'removals' }, { token: '' }); assert.equal(r.status, 401); }
{ const r = await run(fake({ callerActive: false }), { action: 'removals' }); assert.equal(r.status, 403); }
console.log('push-notify removals OK');
