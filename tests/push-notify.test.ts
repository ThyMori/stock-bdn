import assert from 'node:assert/strict';
import { buildPayload, handle, plainText, type Target } from '../supabase/functions/push-notify/index';

const T = (o: Partial<Target> = {}): Target => ({ user_id: 'U', endpoint: 'https://p/1', p256dh: 'k', auth_key: 'a', everyone: false, kind: 'show', show_id: 'S1', show_name: 'Pasolini', author_label: 'Marie D', body: 'Bonjour', ...o });

// ---- contenu des notifications ----
assert.equal(plainText('Merci @[Jean Dupont](u:aaaaaaaa-0000-0000-0000-000000000001)   pour\nle prêt'), 'Merci @Jean Dupont pour le prêt');
assert.ok(plainText('x'.repeat(300)).length <= 140 && plainText('x'.repeat(300)).endsWith('…'));
assert.deepEqual(buildPayload(T(), 'P'), { title: 'Marie D t’a cité · Pasolini', body: 'Bonjour', url: '#/show/S1', tag: 'post-P' });
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
        select: () => chain, eq: () => chain, is: () => chain,
        update: (p: unknown) => { mode = 'update'; calls.push(['update:' + table, p]); return chain; },
        delete: () => { mode = 'delete'; return chain; },
        in: (_c: string, v: unknown) => { calls.push(['delete:' + table, v]); return Promise.resolve({ error: null }); },
        maybeSingle: async () => {
          if (table === 'profiles') return { data: { role: 'technicien', active: o.callerActive ?? true } };
          if (table === 'show_posts') return { data: o.author === 'none' ? null : { id: 'p', author_id: o.author ?? 'ME' } };
          return { data: null };
        },
        then: (res: (v: unknown) => void) => {
          if (table === 'show_posts' && mode === 'update') res({ data: o.claimed === false ? [] : [{ id: 'p' }], error: null });
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
