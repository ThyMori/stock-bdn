import type { Data, Immo, Op } from './types';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function uuid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

/**
 * Extrait un numéro de projecteur du contenu d'un QR code ou d'une saisie :
 *  "132"  ·  "https://…/#/item/132"  ·  "…?id=132"
 */
export function parseScan(text: string): number | null {
  const t = (text ?? '').trim();
  if (/^\d{1,6}$/.test(t)) return Number(t);
  const m = t.match(/(?:#\/item\/|\/item\/|[?&]id=)(\d{1,6})(?!\d)/);
  return m ? Number(m[1]) : null;
}

/** Vue "optimiste" : les données serveur + les actions pas encore synchronisées. */
export function applyPending(data: Data, pending: Op[]): Data {
  if (!pending.length) return data;
  const items = data.items.map((i) => ({ ...i }));
  const byId = new Map(items.map((i) => [i.id, i]));
  const faults = data.faults.map((f) => ({ ...f }));
  const fById = new Map(faults.map((f) => [f.id, f]));
  const faultLog = data.faultLog.map((l) => ({ ...l }));
  const logIds = new Set(faultLog.map((l) => l.id));
  let immos = data.immos;
  for (const op of pending) {
    if (op.kind === 'status') {
      const it = byId.get(op.item);
      if (it && op.at >= it.status_at) {
        it.status = op.status; it.status_at = op.at; it.pending = true;
        // agenda : on clôt ce qui est en cours puis on ouvre la nouvelle immobilisation (comme le fait le serveur)
        const day = dayOf(op.at);
        immos = immos.map((m) => (!m.closed_date && m.item_id === op.item && m.start_date <= day ? { ...m, closed_date: m.start_date > day ? m.start_date : day, pending: true } : m));
        if (op.status !== 'dispo') immos = [...immos, { id: 'p-' + op.id, item_id: op.item, kind: op.status === 'sav' ? 'sav' : 'pret', who: op.who ?? null, note: op.note ?? null,
          start_date: op.from ?? day, end_date: op.until ?? null, closed_date: null, pending: true }];
      }
    } else if (op.kind === 'fault') {
      if (!fById.has(op.id)) {
        const f = { id: op.id, item_id: op.item, description: op.description || null, reported_by_label: null,
          reported_at: op.at, resolved_at: null, resolution: null, pending: true };
        faults.unshift(f); fById.set(f.id, f);
      }
    } else if (op.kind === 'fault_note' || op.kind === 'fault_edit') {
      const f = fById.get(op.fault);
      if (f && !logIds.has(op.id)) {
        faultLog.push({ id: op.id, fault_id: op.fault, kind: op.kind === 'fault_note' ? 'note' : 'edit',
          text: op.kind === 'fault_note' ? op.text : op.description, old_text: op.kind === 'fault_edit' ? f.description : null,
          by_label: null, at: op.at, pending: true });
        logIds.add(op.id);
        if (op.kind === 'fault_edit') { f.description = op.description; f.pending = true; }
      }
    } else {
      const f = fById.get(op.fault);
      if (f && !f.resolved_at) { f.resolved_at = op.at; f.resolution = op.resolution ?? null; f.pending = true; }
    }
  }
  return { ...data, items, faults, faultLog, immos };
}

/** Erreur réseau / session expirée = on réessaiera plus tard. Erreur métier (droits, id inconnu) = rejet définitif. */
export function isTransient(err: { code?: string; message?: string; status?: number } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'PGRST301' || /jwt/i.test(err.message ?? '')) return true;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  return !err.code; // pas de code Postgres/PostgREST => la requête n'a pas abouti
}

export function counts<T extends { status: string }>(items: T[]) {
  const c = { total: items.length, dispo: 0, sav: 0, en_pret: 0 };
  for (const i of items) if (i.status in c) (c as Record<string, number>)[i.status]++;
  return c;
}

export const fmtDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
export const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---------- agenda (immobilisations) ----------
/** Jour local d'un horodatage ISO, au format AAAA-MM-JJ. */
export const dayOf = (iso: string): string => new Date(iso).toLocaleDateString('sv-SE');
export const todayStr = (): string => new Date().toLocaleDateString('sv-SE');
export const dayNum = (d: string): number => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
export const addDays = (d: string, n: number): string => new Date((dayNum(d) + n) * 86400000).toISOString().slice(0, 10);

export type ImmoState = 'planned' | 'running' | 'late' | 'done';
/** Planifiée (pas encore commencée) · en cours · en retard (fin prévue dépassée, pas clôturée) · terminée. */
export function immoState(i: Immo, today: string): ImmoState {
  if (i.closed_date) return 'done';
  if (i.start_date > today) return 'planned';
  if (i.end_date && i.end_date < today) return 'late';
  return 'running';
}
/** Dernier jour affiché de la période ; null = sans fin connue (se prolonge). */
export const immoEnd = (i: Immo): string | null => i.closed_date ?? i.end_date;

/** Position d'une période dans une fenêtre [from, to] (jours inclus), en % de la largeur ; null si hors fenêtre. */
export function barSpan(i: Immo, from: string, to: string): { left: number; width: number; openEnd: boolean; clippedStart: boolean } | null {
  const f = dayNum(from), t = dayNum(to), total = t - f + 1;
  const s = dayNum(i.start_date), endStr = immoEnd(i), e = endStr ? dayNum(endStr) : t;
  if (e < f || s > t) return null;
  const a = Math.max(s, f), b = Math.min(e, t);
  return { left: ((a - f) / total) * 100, width: ((b - a + 1) / total) * 100, openEnd: !endStr, clippedStart: s < f };
}

/** Période en cours (non clôturée, déjà commencée) d'un projecteur. */
export const currentImmo = (immos: Immo[], item: number, today: string): Immo | undefined =>
  immos.filter((m) => m.item_id === item && !m.closed_date && m.start_date <= today).sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
