import { get, set, del } from 'idb-keyval';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { applyPending, isTransient, uuid } from './logic';
import { EMPTY_DATA, ROLE_RANK } from './types';
import type { Data, Op, Profile, Rejected, Role, Status } from './types';

interface State {
  data: Data;            // dernier état connu du serveur
  pending: Op[];         // actions faites mais pas encore confirmées
  rejected: Rejected[];  // actions refusées par le serveur (droits, projecteur supprimé…)
  profile: Profile | null;
  session: Session | null;
  online: boolean;
  syncing: boolean;
  lastPull: string | null;
  error: string | null;
}

export const state: State = {
  data: EMPTY_DATA, pending: [], rejected: [], profile: null, session: null,
  online: navigator.onLine, syncing: false, lastPull: null, error: null
};

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());

/** Données à afficher = serveur + actions en attente. */
export const view = (): Data => applyPending(state.data, state.pending);
export const can = (min: Role): boolean => !!state.profile && ROLE_RANK[state.profile.role] >= ROLE_RANK[min];

// ---------- persistance locale (IndexedDB) ----------
async function persist() {
  await Promise.all([
    set('snapshot', { data: state.data, lastPull: state.lastPull }),
    set('pending', state.pending),
    set('rejected', state.rejected)
  ]);
}

export async function loadLocal() {
  const [snap, pending, rejected, profile] = await Promise.all([
    get('snapshot'), get('pending'), get('rejected'), get('profile')
  ]);
  if (snap) { state.data = { ...EMPTY_DATA, ...snap.data }; state.lastPull = snap.lastPull ?? null; }
  state.pending = pending ?? [];
  state.rejected = rejected ?? [];
  state.profile = profile ?? null;
}

export async function clearLocal() {
  await Promise.all(['snapshot', 'pending', 'rejected', 'profile'].map((k) => del(k)));
  state.data = EMPTY_DATA; state.pending = []; state.rejected = []; state.profile = null; state.lastPull = null;
  emit();
}

// ---------- lecture serveur ----------
export async function loadProfile(userId: string) {
  const { data, error } = await supabase.from('profiles').select('id,email,role,active,first_name,last_name').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (data) { state.profile = data as Profile; await set('profile', state.profile); }
}

/** Accès révoqué par un administrateur : on efface les données de l'appareil et on déconnecte. */
export async function handleRevoked() {
  try { sessionStorage.setItem('revoked', '1'); } catch { /* ignore */ }
  await supabase.auth.signOut().catch(() => {});
  await clearLocal();
  location.hash = '#/';
  location.reload();
}

export async function pull() {
  if (state.session) {
    await loadProfile(state.session.user.id);
    if (state.profile && state.profile.active === false) { await handleRevoked(); throw new Error('Accès révoqué'); }
  }
  const q = (t: string) => supabase.from(t).select('*');
  const [fam, typ, soc, fs, lamps, models, items, faults, flog, imm] = await Promise.all([
    q('families').order('name'), q('item_types').order('name'), q('sockets').order('name'),
    q('filter_sizes').order('label'), q('lamps').order('name'), q('models').order('name'),
    q('items').order('id'), q('faults').order('reported_at', { ascending: false }), q('fault_log').order('at'), q('immos').order('start_date')
  ]);
  for (const r of [fam, typ, soc, fs, lamps, models, items, faults, flog]) if (r.error) throw r.error;
  // agenda : si la table n'existe pas encore (base pas à jour), l'appli reste utilisable sans lui
  if (imm.error && imm.error.code !== '42P01' && imm.error.code !== 'PGRST205') throw imm.error;
  state.data = {
    families: fam.data as Data['families'], types: typ.data as Data['types'], sockets: soc.data as Data['sockets'],
    filterSizes: fs.data as Data['filterSizes'], lamps: lamps.data as Data['lamps'], models: models.data as Data['models'],
    items: items.data as Data['items'], faults: faults.data as Data['faults'], faultLog: flog.data as Data['faultLog'], immos: (imm.error ? [] : imm.data) as Data['immos']
  };
  state.lastPull = new Date().toISOString();
  await persist();
}

// ---------- écriture : file d'attente ----------
async function runOp(op: Op) {
  switch (op.kind) {
    case 'status':
      return supabase.rpc('apply_status', { p_event: op.id, p_item: op.item, p_status: op.status, p_note: op.note ?? null, p_at: op.at,
        p_who: op.who ?? null, p_from: op.from ?? null, p_until: op.until ?? null });
    case 'fault':
      return supabase.rpc('report_fault', { p_id: op.id, p_item: op.item, p_description: op.description, p_at: op.at });
    case 'resolve':
      return supabase.rpc('resolve_fault', { p_event: op.id, p_fault: op.fault, p_resolution: op.resolution ?? null, p_at: op.at });
    case 'fault_note':
      return supabase.rpc('add_fault_note', { p_id: op.id, p_fault: op.fault, p_note: op.text, p_at: op.at });
    case 'fault_edit':
      return supabase.rpc('edit_fault', { p_id: op.id, p_fault: op.fault, p_description: op.description, p_at: op.at });
  }
}

let again = false;
export async function sync(): Promise<void> {
  if (!state.session || !navigator.onLine) return;
  if (state.syncing) { again = true; return; }
  state.syncing = true; state.error = null; emit();
  try {
    let blocked = false;
    while (state.pending.length) {
      const op = state.pending[0];
      const { error } = await runOp(op);
      if (error) {
        if (isTransient(error)) {
          if (/jwt/i.test(error.message) || (error as { code?: string }).code === 'PGRST301') await supabase.auth.refreshSession().catch(() => {});
          blocked = true; break;
        }
        state.rejected.push({ op, message: error.message });
      }
      state.pending.shift();
      await persist();
    }
    if (!blocked) await pull();
  } catch (e) {
    state.error = (e as Error).message || 'Synchronisation impossible';
  } finally {
    state.syncing = false; emit();
    if (again) { again = false; void sync(); }
  }
}

async function enqueue(op: Op) {
  state.pending.push(op);
  await persist();
  emit();
  void sync();
}

const now = () => new Date().toISOString();
export const setStatus = (item: number, status: Status, extra: { note?: string; who?: string; from?: string; until?: string } = {}) =>
  enqueue({ id: uuid(), kind: 'status', item, status, note: extra.note?.trim() || undefined, who: extra.who?.trim() || undefined,
    from: extra.from || undefined, until: extra.until || undefined, at: now() });

/** Agenda : ajout / correction / suppression d'une période (en ligne uniquement). Renvoie un message d'erreur ou null. */
export async function immoCall(fn: 'add_immo' | 'edit_immo' | 'delete_immo', params: Record<string, unknown>): Promise<string | null> {
  if (!navigator.onLine) return 'Cette action demande une connexion.';
  const { error } = await supabase.rpc(fn, params);
  if (error) return error.message;
  await pull(); emit();
  return null;
}
export const reportFault = (item: number, description: string) =>
  enqueue({ id: uuid(), kind: 'fault', item, description: description.trim(), at: now() });
export const resolveFault = (fault: string, resolution?: string) =>
  enqueue({ id: uuid(), kind: 'resolve', fault, resolution: resolution?.trim() || undefined, at: now() });

export const addFaultNote = (fault: string, text: string) =>
  enqueue({ id: uuid(), kind: 'fault_note', fault, text: text.trim(), at: now() });
export const editFault = (fault: string, description: string) =>
  enqueue({ id: uuid(), kind: 'fault_edit', fault, description: description.trim(), at: now() });

export async function dismissRejected(i: number) { state.rejected.splice(i, 1); await persist(); emit(); }

// ---------- session ----------
export function setSession(s: Session | null) { state.session = s; emit(); }
export function setOnline(v: boolean) { state.online = v; emit(); }
export { emit };
